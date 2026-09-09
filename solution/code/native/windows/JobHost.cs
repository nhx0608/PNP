using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace PNP {
  // A private supervisor owns the job handle. EOF or parent exit closes the job.
  // One compilation unit serves three operations: guard, inspect and launch.
  // All protocol traffic is JSONL. No command line, environment or raw stderr is logged.
  public static class JobHost {
    [StructLayout(LayoutKind.Sequential)] struct SA { public int nLength; public IntPtr lpSecurityDescriptor; public int inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct SI {
      public int cb; public string reserved; public string desktop; public string title;
      public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,reserved2;
      public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC {
      public long processTime, jobTime; public uint flags;
      public UIntPtr minWorking, maxWorking; public uint activeLimit;
      public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO {
      public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXT {
      public BASIC basic; public IO io;
      public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNT {
      public long user, kernel, periodUser, periodKernel;
      public uint faults, total, active, terminated;
    }
    [StructLayout(LayoutKind.Sequential)] struct FT { public uint low, high; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT value, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, ref ACCOUNT value, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SA attr, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(
      string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(
      IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(
      IntPtr process, out FT creation, out FT exit, out FT kernel, out FT user);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };
    static readonly object Output = new object();
    // Owned kernel handles must not be used after the main path has closed them.
    static readonly object HandleGate = new object();
    static bool HandlesClosed = false;
    static void Emit(object value) { lock (Output) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); } }
    static void Check(bool ok) { if (!ok) throw new InvalidOperationException("WIN32_" + Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
      var b = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') b.Append('\\', slashes * 2 + 1); else b.Append('\\', slashes);
        b.Append(c); slashes = 0;
      }
      b.Append('\\', slashes * 2); return b.Append('"').ToString();
    }
    static FileStream Stream(IntPtr handle, FileAccess access) { return new FileStream(new SafeFileHandle(handle, true), access, 4096, false); }
    static Task Pump(Stream stream, string type) {
      return Task.Run(() => {
        byte[] bytes = new byte[8192]; int n;
        try { while ((n = stream.Read(bytes, 0, bytes.Length)) > 0) Emit(new { type = type, data = Convert.ToBase64String(bytes, 0, n) }); }
        catch (IOException) { }
        finally { stream.Dispose(); }
      });
    }
    static bool IsEmpty(IntPtr job) {
      ACCOUNT info = new ACCOUNT();
      Check(QueryInformationJobObject(job, 1, ref info, (uint)Marshal.SizeOf(typeof(ACCOUNT)), IntPtr.Zero));
      return info.active == 0;
    }
    // An unanswerable query is not evidence of quiescence.
    static bool SafeIsEmpty(IntPtr job) {
      try { return IsEmpty(job); } catch (InvalidOperationException) { return false; }
    }
    // A descendant must not inherit this supervisor's own standard handles, or the output pump
    // never sees end of file while any process in the tree is still alive.
    static void ProtectStandardHandle(int id) {
      IntPtr handle = GetStdHandle(id);
      if (handle == IntPtr.Zero || handle == new IntPtr(-1)) return;
      SetHandleInformation(handle, 1, 0); // Best effort: a console handle may refuse and cannot leak a pipe.
    }
    static IntPtr OpenExclusive(string value) {
      IntPtr handle = CreateFile(value, 0xC0000000, 0, IntPtr.Zero, 4, 0x80, IntPtr.Zero); // OPEN_ALWAYS, no sharing.
      if (handle == new IntPtr(-1)) throw new InvalidOperationException("INSTANCE_OWNED_" + Marshal.GetLastWin32Error());
      return handle;
    }
    static void Guard(Dictionary<string, object> input) {
      IntPtr recovery = IntPtr.Zero, gateway = IntPtr.Zero, target = IntPtr.Zero;
      try {
        if (!input.ContainsKey("directory") || !input.ContainsKey("pid")) throw new InvalidOperationException("INVALID_GUARD_INPUT");
        string directory = input["directory"] as string;
        int pid = Convert.ToInt32(input["pid"]);
        if (String.IsNullOrEmpty(directory) || !Path.IsPathRooted(directory) || pid <= 0) throw new InvalidOperationException("INVALID_GUARD_INPUT");
        recovery = OpenExclusive(Path.Combine(directory, "recovery.lock"));
        gateway = OpenExclusive(Path.Combine(directory, "gateway.lock"));
        target = OpenProcess(0x00100000 | 0x0040 | 0x1000, false, (uint)pid);
        if (target == IntPtr.Zero) throw new InvalidOperationException("OWNER_PROCESS_UNAVAILABLE");
        FT created, exited, kernel, user;
        Check(GetProcessTimes(target, out created, out exited, out kernel, out user));
        IntPtr remoteRecovery, remoteGateway;
        Check(DuplicateHandle(GetCurrentProcess(), recovery, target, out remoteRecovery, 0, false, 2));
        Check(DuplicateHandle(GetCurrentProcess(), gateway, target, out remoteGateway, 0, false, 2));
        ulong creation = ((ulong)created.high << 32) | created.low;
        Emit(new { ok = true, pid = pid, creationTime = creation.ToString() });
      } catch (Exception error) {
        Emit(new { ok = false, code = error.Message.StartsWith("INSTANCE_OWNED_", StringComparison.Ordinal) ? "INSTANCE_LOCKED" : "INSTANCE_GUARD_FAILED" });
      } finally {
        if (target != IntPtr.Zero) CloseHandle(target);
        if (gateway != IntPtr.Zero && gateway != new IntPtr(-1)) CloseHandle(gateway);
        if (recovery != IntPtr.Zero && recovery != new IntPtr(-1)) CloseHandle(recovery);
      }
    }
    // One interpreter start inspects any number of jobs.
    static void Inspect(Dictionary<string, object> config) {
      var names = new List<string>();
      if (config.ContainsKey("jobNames") && config["jobNames"] is System.Collections.IEnumerable) {
        foreach (object item in (System.Collections.IEnumerable)config["jobNames"]) {
          if (item is string) names.Add((string)item);
        }
      }
      if (names.Count == 0 && config.ContainsKey("jobName") && config["jobName"] is string) names.Add((string)config["jobName"]);
      if (names.Count == 0) throw new InvalidOperationException("INVALID_JOB_NAME");
      int session = Process.GetCurrentProcess().SessionId;
      var results = new List<object>();
      bool first = false;
      for (int i = 0; i < names.Count; i++) {
        string name = names[i];
        bool quiescent = false;
        int error = 0;
        if (!name.StartsWith("Local\\PNP-", StringComparison.Ordinal)) {
          error = -1;
        } else {
          IntPtr handle = OpenJobObject(4, false, name);
          error = Marshal.GetLastWin32Error();
          if (handle == IntPtr.Zero) {
            quiescent = error == 2; // ERROR_FILE_NOT_FOUND: the job namespace entry is gone.
          } else {
            quiescent = SafeIsEmpty(handle);
            error = 0;
            CloseHandle(handle);
          }
        }
        if (i == 0) first = quiescent;
        results.Add(new { jobName = name, quiescent = quiescent, error = error });
      }
      Emit(new { type = "inspection", windowsSessionId = session, quiescent = first, results = results.ToArray() });
    }
    public static void Run() {
      string phase = "config";
      IntPtr job = IntPtr.Zero, environment = IntPtr.Zero;
      PI pi = new PI();
      IntPtr childIn=IntPtr.Zero, parentIn=IntPtr.Zero, parentOut=IntPtr.Zero, childOut=IntPtr.Zero, parentErr=IntPtr.Zero, childErr=IntPtr.Zero;
      try {
        string first = Console.ReadLine();
        if (first == null) return;
        var config = Json.Deserialize<Dictionary<string, object>>(first);
        if (config == null || !config.ContainsKey("operation") || !(config["operation"] is string)) throw new InvalidOperationException("INVALID_OPERATION");
        string operation = (string)config["operation"];
        if (operation == "guard") { Guard(config); return; }
        if (operation == "inspect") { Inspect(config); return; }
        if (operation != "launch") throw new InvalidOperationException("INVALID_OPERATION");
        if (!config.ContainsKey("jobName") || !(config["jobName"] is string)) throw new InvalidOperationException("INVALID_JOB_NAME");
        string name = (string)config["jobName"];
        if (!name.StartsWith("Local\\PNP-", StringComparison.Ordinal)) throw new InvalidOperationException("INVALID_JOB_NAME");
        int defaultGrace = 3000;
        if (config.ContainsKey("graceMs")) defaultGrace = Convert.ToInt32(config["graceMs"]);
        if (defaultGrace < 0) defaultGrace = 0;
        if (defaultGrace > 60000) defaultGrace = 60000;
        // Do not create a Job or process until the Node owner has durably recorded
        // the Windows object namespace in which this supervisor operates.
        Emit(new { type="prepared", windowsSessionId=Process.GetCurrentProcess().SessionId });
        string proceedLine = Console.ReadLine();
        var proceed = proceedLine == null ? null : Json.Deserialize<Dictionary<string,object>>(proceedLine);
        if (proceed == null || !proceed.ContainsKey("type") || (string)proceed["type"] != "proceed")
          throw new InvalidOperationException("LAUNCH_NOT_COMMITTED");
        phase = "job";
        job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new InvalidOperationException("CREATE_JOB_FAILED");
        if (Marshal.GetLastWin32Error() == 183) throw new InvalidOperationException("JOB_ALREADY_EXISTS");
        EXT limits = new EXT(); limits.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaway permission.
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXT))));
        SA attr = new SA { nLength=Marshal.SizeOf(typeof(SA)), inherit=1 };
        Check(CreatePipe(out childIn, out parentIn, ref attr, 0));
        Check(CreatePipe(out parentOut, out childOut, ref attr, 0));
        Check(CreatePipe(out parentErr, out childErr, ref attr, 0));
        Check(SetHandleInformation(parentIn, 1, 0)); Check(SetHandleInformation(parentOut, 1, 0)); Check(SetHandleInformation(parentErr, 1, 0));
        ProtectStandardHandle(-10); ProtectStandardHandle(-11); ProtectStandardHandle(-12);
        string executable = (string)config["executable"];
        if (!Path.IsPathRooted(executable) || !executable.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("ABSOLUTE_EXE_REQUIRED");
        var command = new StringBuilder(Quote(executable));
        foreach (object item in (System.Collections.IEnumerable)config["args"]) command.Append(' ').Append(Quote((string)item));
        var values = (Dictionary<string, object>)config["env"];
        var envNames = new List<string>(values.Keys); envNames.Sort(StringComparer.OrdinalIgnoreCase);
        var block = new StringBuilder();
        foreach (string key in envNames) {
          string value = (string)values[key];
          if (key.IndexOf('=') >= 0 || key.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0) throw new InvalidOperationException("INVALID_ENVIRONMENT");
          block.Append(key).Append('=').Append(value).Append('\0');
        }
        block.Append('\0'); environment = Marshal.StringToHGlobalUni(block.ToString());
        SI startup = new SI { cb=Marshal.SizeOf(typeof(SI)), flags=0x100, stdin=childIn, stdout=childOut, stderr=childErr };
        phase = "spawn";
        // The root cannot execute or create descendants before membership is established.
        Check(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x400 | 0x08000000,
          environment, (string)config["cwd"], ref startup, out pi));
        if (!AssignProcessToJobObject(job, pi.process)) { TerminateProcess(pi.process, 1); throw new InvalidOperationException("ASSIGN_JOB_FAILED"); }
        CloseHandle(childIn); childIn=IntPtr.Zero; CloseHandle(childOut); childOut=IntPtr.Zero; CloseHandle(childErr); childErr=IntPtr.Zero;
        Check(ResumeThread(pi.thread) != UInt32.MaxValue);
        phase = "running";
        var stdin = Stream(parentIn, FileAccess.Write); parentIn=IntPtr.Zero;
        Task stdout = Pump(Stream(parentOut, FileAccess.Read), "stdout"); parentOut=IntPtr.Zero;
        Task stderr = Pump(Stream(parentErr, FileAccess.Read), "stderr"); parentErr=IntPtr.Zero;
        IntPtr ownedJob = job;
        IntPtr ownedProcess = pi.process;
        int startGrace = defaultGrace;
        Task.Run(() => {
          bool graceful = true;
          int grace = startGrace;
          try {
            string line;
            while ((line = Console.ReadLine()) != null) {
              var message = Json.Deserialize<Dictionary<string, object>>(line);
              if (message == null || !message.ContainsKey("type") || !(message["type"] is string)) throw new InvalidOperationException("INVALID_CONTROL");
              string kind = (string)message["type"];
              if (kind == "terminate") {
                if (message.ContainsKey("graceMs")) grace = Convert.ToInt32(message["graceMs"]);
                if (grace < 0) grace = 0;
                if (grace > 60000) grace = 60000;
                break;
              }
              if (kind != "write") throw new InvalidOperationException("INVALID_CONTROL");
              byte[] bytes = Convert.FromBase64String((string)message["data"]);
              stdin.Write(bytes, 0, bytes.Length); stdin.Flush();
            }
          } catch (Exception) {
            graceful = false; // A malformed control frame is a hard stop, not a graceful one.
          }
          // Phase one: a real end of file lets the engine finish saving before anything is killed.
          try { stdin.Dispose(); } catch (IOException) { } catch (ObjectDisposedException) { }
          lock (HandleGate) {
            if (HandlesClosed) return;
            if (graceful && WaitForSingleObject(ownedProcess, (uint)grace) == 0) return;
            TerminateJobObject(ownedJob, 1);
          }
        });
        int parentPid = Convert.ToInt32(config["parentPid"]);
        Task.Run(() => {
          // Losing the synchronisation right must not look like a dead parent.
          bool gone = false;
          try { Process parent = Process.GetProcessById(parentPid); parent.WaitForExit(); gone = true; }
          catch (ArgumentException) { gone = true; }
          catch (Exception) { gone = false; }
          while (!gone) {
            Thread.Sleep(500);
            lock (HandleGate) { if (HandlesClosed) return; }
            try {
              Process probe = Process.GetProcessById(parentPid);
              if (probe.HasExited) gone = true;
            }
            catch (ArgumentException) { gone = true; }
            catch (Exception) { }
          }
          lock (HandleGate) { if (!HandlesClosed) TerminateJobObject(ownedJob, 1); }
        });
        Emit(new { type="ready", pid=pi.pid, jobName=name, windowsSessionId=Process.GetCurrentProcess().SessionId });
        WaitForSingleObject(pi.process, UInt32.MaxValue);
        uint code; GetExitCodeProcess(pi.process, out code);
        // A root exit must not strand descendants waiting on inherited pipes.
        lock (HandleGate) { if (!HandlesClosed) TerminateJobObject(job, code); }
        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        while (!SafeIsEmpty(job) && DateTime.UtcNow < deadline) Thread.Sleep(20);
        bool drained = Task.WaitAll(new Task[] { stdout, stderr }, 5000);
        Emit(new { type="exit", code=code, quiescent=SafeIsEmpty(job), drained=drained });
      } catch (Exception error) {
        if (pi.process != IntPtr.Zero) TerminateProcess(pi.process, 1);
        if (job != IntPtr.Zero) TerminateJobObject(job, 1);
        Emit(new { type="error", code="HOST_FAILURE", phase=phase, message=error.GetType().Name });
      } finally {
        if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
        lock (HandleGate) {
          HandlesClosed = true;
          foreach (IntPtr h in new IntPtr[] {childIn,parentIn,parentOut,childOut,parentErr,childErr,pi.thread,pi.process,job}) if (h != IntPtr.Zero) CloseHandle(h);
        }
      }
    }
  }
}
