using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace MiniHarness.NativeSandbox
{
    // Windows-native command sandbox. The controller stays outside this boundary;
    // only the model-generated command tree is launched with the restricted token.
    public static class Runner
    {
        private const UInt32 TOKEN_ASSIGN_PRIMARY = 0x0001;
        private const UInt32 TOKEN_DUPLICATE = 0x0002;
        private const UInt32 TOKEN_QUERY = 0x0008;
        private const UInt32 TOKEN_ADJUST_PRIVILEGES = 0x0020;
        private const UInt32 TOKEN_ADJUST_DEFAULT = 0x0080;
        private const UInt32 TOKEN_ADJUST_SESSIONID = 0x0100;

        private const UInt32 DISABLE_MAX_PRIVILEGE = 0x1;
        private const UInt32 WRITE_RESTRICTED = 0x8;
        private const UInt32 SE_GROUP_LOGON_ID = 0xC0000000;
        private const Int32 TokenGroups = 2;
        private const Int32 TokenDefaultDacl = 6;
        private const Int32 GENERIC_ALL = unchecked((int)0x10000000);

        private const UInt32 STARTF_USESTDHANDLES = 0x00000100;
        private const UInt32 CREATE_SUSPENDED = 0x00000004;
        private const UInt32 CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const UInt32 CREATE_NO_WINDOW = 0x08000000;
        private const UInt32 HANDLE_FLAG_INHERIT = 0x00000001;
        private const UInt32 INFINITE = 0xffffffff;

        private const UInt32 JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008;
        private const UInt32 JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
        private const UInt32 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const Int32 JobObjectExtendedLimitInformation = 9;
        private const Int32 JobObjectCpuRateControlInformation = 15;
        private const UInt32 JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
        private const UInt32 JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;

        private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

        /** 能力 SID 拿到的工作区写权限：Modify + 删除子项（不含改 ACL/属主） */
        private static readonly FileSystemRights SandboxRootRights =
            FileSystemRights.Modify | FileSystemRights.DeleteSubdirectoriesAndFiles;

        public static int Run(
            string command,
            string capabilityKey,
            string workingDirectory,
            string[] writableRoots,
            string privateTempRoot,
            int processLimit,
            long memoryLimitBytes,
            int cpuRate)
        {
            if (String.IsNullOrWhiteSpace(command)) throw new ArgumentException("command is empty");
            string cwd = ValidateDirectory(workingDirectory, false);
            string temp = ValidateDirectory(privateTempRoot, true);
            string capabilitySid = GetCapabilitySid(capabilityKey);

            // The restricting SID only receives write access to the private temp and the
            // selected roots. With WRITE_RESTRICTED, Windows checks both the normal user
            // token and this SID for writes, so obfuscated shell commands cannot escape.
            GrantWritableRoot(temp, capabilitySid);
            if (writableRoots != null)
            {
                foreach (string root in writableRoots)
                {
                    if (!String.IsNullOrWhiteSpace(root)) GrantWritableRoot(ValidateDirectory(root, false), capabilitySid);
                }
            }

            IntPtr sourceToken = IntPtr.Zero;
            IntPtr restrictedToken = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
            List<GCHandle> sidPins = new List<GCHandle>();
            IntPtr restrictingBuffer = IntPtr.Zero;
            try
            {
                UInt32 tokenAccess = TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY |
                    TOKEN_ADJUST_PRIVILEGES | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID;
                Check(OpenProcessToken(GetCurrentProcess(), tokenAccess, out sourceToken), "OpenProcessToken");
                if (IsTokenRestricted(sourceToken))
                    throw new InvalidOperationException(
                        "the parent process already has a restricted token; nested capability sandboxes are not supported");

                // World / logon SIDs are needed for the Windows session objects used
                // during process initialization. The synthetic capability is the only
                // SID that receives filesystem Modify on sandbox roots.
                List<SecurityIdentifier> restrictingSids = new List<SecurityIdentifier>();
                restrictingSids.Add(new SecurityIdentifier(WellKnownSidType.WorldSid, null));
                restrictingSids.Add(new SecurityIdentifier("S-1-2-1"));
                SecurityIdentifier logonSid = FindLogonSid(sourceToken);
                if (logonSid != null) restrictingSids.Add(logonSid);
                restrictingSids.Add(new SecurityIdentifier(capabilitySid));

                int sidAndAttributesSize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
                restrictingBuffer = Marshal.AllocHGlobal(sidAndAttributesSize * restrictingSids.Count);
                for (int i = 0; i < restrictingSids.Count; i++)
                {
                    SecurityIdentifier sid = restrictingSids[i];
                    byte[] sidBytes = new byte[sid.BinaryLength];
                    sid.GetBinaryForm(sidBytes, 0);
                    GCHandle pin = GCHandle.Alloc(sidBytes, GCHandleType.Pinned);
                    sidPins.Add(pin);
                    SID_AND_ATTRIBUTES restricting = new SID_AND_ATTRIBUTES {
                        Sid = pin.AddrOfPinnedObject(), Attributes = 0
                    };
                    Marshal.StructureToPtr(
                        restricting,
                        new IntPtr(restrictingBuffer.ToInt64() + (long)i * sidAndAttributesSize),
                        false);
                }
                Check(CreateRestrictedToken(
                    sourceToken,
                    DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED,
                    0,
                    IntPtr.Zero,
                    0,
                    IntPtr.Zero,
                    (UInt32)restrictingSids.Count,
                    restrictingBuffer,
                    out restrictedToken), "CreateRestrictedToken");
                GrantCapabilityInDefaultDacl(restrictedToken, new SecurityIdentifier(capabilitySid));

                job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) ThrowLastError("CreateJobObject");
                ConfigureJob(job, processLimit, memoryLimitBytes, cpuRate);

                string powershell = Environment.ExpandEnvironmentVariables(
                    @"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe");
                if (!File.Exists(powershell)) powershell = "powershell.exe";
                string prelude = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';" +
                    // 受限环境下 PowerShell 可能落在 ConstrainedLanguage：编码设置只是为了让输出不乱码，
                    // 失败也不能把整条命令带走（命令本身该跑还是要跑）。
                    "try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch { };" +
                    "$OutputEncoding=[Text.Encoding]::UTF8;" +
                    "try { chcp 65001 > $null } catch { };";
                string encoded = Convert.ToBase64String(Encoding.Unicode.GetBytes(prelude + command));
                StringBuilder commandLine = new StringBuilder(
                    Quote(powershell) + " -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded);

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.dwFlags = STARTF_USESTDHANDLES;
                startup.hStdInput = GetStdHandle(-10);
                startup.hStdOutput = GetStdHandle(-11);
                startup.hStdError = GetStdHandle(-12);
                MarkInheritable(startup.hStdInput);
                MarkInheritable(startup.hStdOutput);
                MarkInheritable(startup.hStdError);

                Check(CreateProcessAsUser(
                    restrictedToken,
                    powershell,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                    IntPtr.Zero,
                    cwd,
                    ref startup,
                    out pi), "CreateProcessAsUser");
                Check(AssignProcessToJobObject(job, pi.hProcess), "AssignProcessToJobObject");
                if (ResumeThread(pi.hThread) == 0xffffffff) ThrowLastError("ResumeThread");
                UInt32 wait = WaitForSingleObject(pi.hProcess, INFINITE);
                if (wait != 0) throw new Win32Exception("WaitForSingleObject returned " + wait);
                UInt32 exitCode;
                Check(GetExitCodeProcess(pi.hProcess, out exitCode), "GetExitCodeProcess");
                return unchecked((int)exitCode);
            }
            finally
            {
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                // KILL_ON_JOB_CLOSE guarantees timeout/abort kills the whole descendant tree.
                if (job != IntPtr.Zero) CloseHandle(job);
                if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
                if (sourceToken != IntPtr.Zero) CloseHandle(sourceToken);
                if (restrictingBuffer != IntPtr.Zero) Marshal.FreeHGlobal(restrictingBuffer);
                foreach (GCHandle pin in sidPins) if (pin.IsAllocated) pin.Free();
            }
        }

        public static string CapabilitySid(string capabilityKey)
        {
            return GetCapabilitySid(capabilityKey);
        }

        private static string GetCapabilitySid(string capabilityKey)
        {
            if (String.IsNullOrWhiteSpace(capabilityKey)) throw new ArgumentException("capability key is empty");
            byte[] input = Encoding.UTF8.GetBytes("mini-harness.windows-sandbox.v1:" + capabilityKey);
            byte[] digest;
            using (SHA256 sha = SHA256.Create()) digest = sha.ComputeHash(input);
            // A deterministic, non-existent account-style SID is used as a pure
            // capability identifier. It is never a login identity.
            StringBuilder sid = new StringBuilder("S-1-5-21");
            for (int i = 0; i < 4; i++) sid.Append('-').Append(BitConverter.ToUInt32(digest, i * 4));
            return sid.ToString();
        }

        private static string ValidateDirectory(string value, bool create)
        {
            if (String.IsNullOrWhiteSpace(value)) throw new ArgumentException("directory is empty");
            string full = Path.GetFullPath(value);
            string root = Path.GetPathRoot(full);
            if (String.Equals(full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("refusing to grant a filesystem root: " + full);
            if (create) Directory.CreateDirectory(full);
            if (!Directory.Exists(full)) throw new DirectoryNotFoundException(full);
            FileAttributes attrs = File.GetAttributes(full);
            if ((attrs & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("refusing a reparse-point sandbox root: " + full);
            return full;
        }

        private static void GrantWritableRoot(string root, string sidText)
        {
            SecurityIdentifier sid = new SecurityIdentifier(sidText);
            DirectorySecurity security = Directory.GetAccessControl(root, AccessControlSections.Access);
            // 每条命令都重写 ACL 会让 Windows 重新向整棵子树传播继承（几万个文件的目录上是秒级），
            // 所以先看能力 SID 的显式 ACE 是否已经够用；够用就完全不碰 ACL。
            if (HasExplicitGrant(security, sid)) return;

            FileSystemAccessRule rule = new FileSystemAccessRule(
                sid,
                SandboxRootRights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                AccessControlType.Allow);
            bool modified;
            security.ModifyAccessRule(AccessControlModification.Set, rule, out modified);
            Directory.SetAccessControl(root, security);
        }

        private static bool HasExplicitGrant(DirectorySecurity security, SecurityIdentifier sid)
        {
            foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier)))
            {
                if (rule.AccessControlType != AccessControlType.Allow) continue;
                if (!sid.Equals(rule.IdentityReference)) continue;
                if ((rule.FileSystemRights & SandboxRootRights) != SandboxRootRights) continue;
                if ((rule.InheritanceFlags & InheritanceFlags.ContainerInherit) == 0) continue;
                if ((rule.InheritanceFlags & InheritanceFlags.ObjectInherit) == 0) continue;
                return true;
            }
            return false;
        }

        private static SecurityIdentifier FindLogonSid(IntPtr token)
        {
            UInt32 needed = 0;
            GetTokenInformation(token, TokenGroups, IntPtr.Zero, 0, out needed);
            if (needed == 0) return null;
            IntPtr buffer = Marshal.AllocHGlobal((int)needed);
            try
            {
                Check(GetTokenInformation(token, TokenGroups, buffer, needed, out needed), "GetTokenInformation(TokenGroups)");
                UInt32 count = (UInt32)Marshal.ReadInt32(buffer);
                int first = Marshal.OffsetOf(typeof(TOKEN_GROUPS_HEADER), "FirstGroup").ToInt32();
                int stride = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
                for (UInt32 i = 0; i < count; i++)
                {
                    IntPtr entry = new IntPtr(buffer.ToInt64() + first + (long)i * stride);
                    SID_AND_ATTRIBUTES group = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(entry, typeof(SID_AND_ATTRIBUTES));
                    if ((group.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID)
                        return new SecurityIdentifier(group.Sid);
                }
                return null;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static void GrantCapabilityInDefaultDacl(IntPtr token, SecurityIdentifier capabilitySid)
        {
            UInt32 needed = 0;
            GetTokenInformation(token, TokenDefaultDacl, IntPtr.Zero, 0, out needed);
            if (needed == 0) ThrowLastError("GetTokenInformation(TokenDefaultDacl size)");
            IntPtr tokenInfo = Marshal.AllocHGlobal((int)needed);
            IntPtr newAclBuffer = IntPtr.Zero;
            IntPtr newInfo = IntPtr.Zero;
            try
            {
                Check(GetTokenInformation(token, TokenDefaultDacl, tokenInfo, needed, out needed), "GetTokenInformation(TokenDefaultDacl)");
                IntPtr oldAclPointer = Marshal.ReadIntPtr(tokenInfo);
                if (oldAclPointer == IntPtr.Zero) throw new InvalidOperationException("token has no default DACL");
                int oldAclSize = (UInt16)Marshal.ReadInt16(oldAclPointer, 2);
                byte[] oldAclBytes = new byte[oldAclSize];
                Marshal.Copy(oldAclPointer, oldAclBytes, 0, oldAclSize);
                RawAcl acl = new RawAcl(oldAclBytes, 0);
                acl.InsertAce(0, new CommonAce(
                    AceFlags.None,
                    AceQualifier.AccessAllowed,
                    GENERIC_ALL,
                    capabilitySid,
                    false,
                    null));

                byte[] newAclBytes = new byte[acl.BinaryLength];
                acl.GetBinaryForm(newAclBytes, 0);
                newAclBuffer = Marshal.AllocHGlobal(newAclBytes.Length);
                Marshal.Copy(newAclBytes, 0, newAclBuffer, newAclBytes.Length);
                newInfo = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(newInfo, newAclBuffer);
                Check(SetTokenInformation(token, TokenDefaultDacl, newInfo, (UInt32)IntPtr.Size), "SetTokenInformation(TokenDefaultDacl)");
            }
            finally
            {
                if (newInfo != IntPtr.Zero) Marshal.FreeHGlobal(newInfo);
                if (newAclBuffer != IntPtr.Zero) Marshal.FreeHGlobal(newAclBuffer);
                Marshal.FreeHGlobal(tokenInfo);
            }
        }

        private static void ConfigureJob(IntPtr job, int processLimit, long memoryLimitBytes, int cpuRate)
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (processLimit > 0)
            {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                info.BasicLimitInformation.ActiveProcessLimit = (UInt32)processLimit;
            }
            if (memoryLimitBytes > 0)
            {
                info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                info.JobMemoryLimit = new UIntPtr((UInt64)memoryLimitBytes);
            }
            Check(SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                ref info,
                (UInt32)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))),
                "SetInformationJobObject");
            if (cpuRate > 0)
            {
                JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu = new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION();
                cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP;
                cpu.CpuRate = (UInt32)Math.Max(1, Math.Min(10000, cpuRate));
                Check(SetInformationJobObjectCpu(
                    job,
                    JobObjectCpuRateControlInformation,
                    ref cpu,
                    (UInt32)Marshal.SizeOf(typeof(JOBOBJECT_CPU_RATE_CONTROL_INFORMATION))),
                    "SetInformationJobObject(CPU)");
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void MarkInheritable(IntPtr handle)
        {
            if (handle == IntPtr.Zero || handle == INVALID_HANDLE_VALUE) return;
            SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
        }

        private static void Check(bool ok, string operation)
        {
            if (!ok) ThrowLastError(operation);
        }

        private static void ThrowLastError(string operation)
        {
            int code = Marshal.GetLastWin32Error();
            throw new Win32Exception(code, operation + " failed with Win32 error " + code);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SID_AND_ATTRIBUTES
        {
            public IntPtr Sid;
            public UInt32 Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TOKEN_GROUPS_HEADER
        {
            public UInt32 GroupCount;
            public SID_AND_ATTRIBUTES FirstGroup;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public Int32 cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public UInt32 dwX;
            public UInt32 dwY;
            public UInt32 dwXSize;
            public UInt32 dwYSize;
            public UInt32 dwXCountChars;
            public UInt32 dwYCountChars;
            public UInt32 dwFillAttribute;
            public UInt32 dwFlags;
            public UInt16 wShowWindow;
            public UInt16 cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public UInt32 dwProcessId;
            public UInt32 dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public Int64 PerProcessUserTimeLimit;
            public Int64 PerJobUserTimeLimit;
            public UInt32 LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public UInt32 ActiveProcessLimit;
            public IntPtr Affinity;
            public UInt32 PriorityClass;
            public UInt32 SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public UInt64 ReadOperationCount;
            public UInt64 WriteOperationCount;
            public UInt64 OtherOperationCount;
            public UInt64 ReadTransferCount;
            public UInt64 WriteTransferCount;
            public UInt64 OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION
        {
            public UInt32 ControlFlags;
            public UInt32 CpuRate;
        }

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr processHandle, UInt32 desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool IsTokenRestricted(IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle,
            Int32 tokenInformationClass,
            IntPtr tokenInformation,
            UInt32 tokenInformationLength,
            out UInt32 returnLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool SetTokenInformation(
            IntPtr tokenHandle,
            Int32 tokenInformationClass,
            IntPtr tokenInformation,
            UInt32 tokenInformationLength);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool CreateRestrictedToken(
            IntPtr existingTokenHandle,
            UInt32 flags,
            UInt32 disableSidCount,
            IntPtr sidsToDisable,
            UInt32 deletePrivilegeCount,
            IntPtr privilegesToDelete,
            UInt32 restrictedSidCount,
            IntPtr sidsToRestrict,
            out IntPtr newTokenHandle);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcessAsUser(
            IntPtr token,
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            UInt32 creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            Int32 infoClass,
            ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info,
            UInt32 infoLength);

        [DllImport("kernel32.dll", EntryPoint = "SetInformationJobObject", SetLastError = true)]
        private static extern bool SetInformationJobObjectCpu(
            IntPtr job,
            Int32 infoClass,
            ref JOBOBJECT_CPU_RATE_CONTROL_INFORMATION info,
            UInt32 infoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern UInt32 ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out UInt32 exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(Int32 standardHandle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(IntPtr handle, UInt32 mask, UInt32 flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
