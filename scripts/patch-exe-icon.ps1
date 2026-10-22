# Windows 原生资源 API 写入 ICO，无需签名工具或符号链接；只处理指定的打包产物。
param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Icon,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class TraceryIconResource {
  delegate bool Names(IntPtr module, IntPtr type, IntPtr name, IntPtr parameter);
  delegate bool Languages(IntPtr module, IntPtr type, IntPtr name, ushort language, IntPtr parameter);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibraryEx(string file, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr module);
  [DllImport("kernel32.dll", EntryPoint="EnumResourceNamesW", SetLastError=true)] static extern bool EnumNames(IntPtr module, IntPtr type, Names callback, IntPtr parameter);
  [DllImport("kernel32.dll", EntryPoint="EnumResourceLanguagesW", SetLastError=true)] static extern bool EnumLanguages(IntPtr module, IntPtr type, IntPtr name, Languages callback, IntPtr parameter);
  [DllImport("kernel32.dll", EntryPoint="FindResourceExW", SetLastError=true)] static extern IntPtr FindResource(IntPtr module, IntPtr type, IntPtr name, ushort language);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll")] static extern IntPtr LockResource(IntPtr resource);
  [DllImport("kernel32.dll")] static extern uint SizeofResource(IntPtr module, IntPtr resource);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
  [DllImport("kernel32.dll", EntryPoint="UpdateResourceW", SetLastError=true)] static extern bool UpdateResource(IntPtr update, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResource(IntPtr update, bool discard);
  class Group { public string Text; public ushort Id; public ushort Language; }
  static Exception Error() { return new Win32Exception(Marshal.GetLastWin32Error()); }
  static IntPtr Open(string file) { IntPtr module=LoadLibraryEx(file, IntPtr.Zero, 2); if(module==IntPtr.Zero) throw Error(); return module; }
  static List<Group> Groups(IntPtr module) {
    var groups=new List<Group>();
    Names callback=delegate(IntPtr m, IntPtr type, IntPtr name, IntPtr parameter) {
      long value=name.ToInt64();
      string text=value>65535 || value<0 ? Marshal.PtrToStringUni(name) : null;
      ushort id=text==null ? (ushort)value : (ushort)0;
      Languages languages=delegate(IntPtr a, IntPtr b, IntPtr c, ushort language, IntPtr d) { groups.Add(new Group { Text=text, Id=id, Language=language }); return true; };
      if(!EnumLanguages(m,type,name,languages,IntPtr.Zero)) throw Error();
      return true;
    };
    EnumNames(module,new IntPtr(14),callback,IntPtr.Zero);
    return groups;
  }
  static byte[] Read(IntPtr module, int type, IntPtr name, ushort language) {
    IntPtr resource=FindResource(module,new IntPtr(type),name,language); if(resource==IntPtr.Zero) throw Error();
    byte[] bytes=new byte[SizeofResource(module,resource)];
    Marshal.Copy(LockResource(LoadResource(module,resource)),bytes,0,bytes.Length); return bytes;
  }
  static void Put(IntPtr update, int type, IntPtr name, ushort language, byte[] bytes) {
    if(!UpdateResource(update,new IntPtr(type),name,language,bytes,(uint)bytes.Length)) throw Error();
  }
  public static void Process(string executable, string icon, bool verifyOnly) {
    byte[] ico=File.ReadAllBytes(icon);
    if(ico.Length<6 || BitConverter.ToUInt16(ico,0)!=0 || BitConverter.ToUInt16(ico,2)!=1) throw new Exception("ICO header invalid");
    int count=BitConverter.ToUInt16(ico,4);
    if(count<1 || count>255 || ico.Length<6+count*16) throw new Exception("ICO directory invalid");
    byte[] header=new byte[6+count*14]; Buffer.BlockCopy(ico,0,header,0,6);
    var frames=new List<byte[]>();
    for(int i=0;i<count;i++) {
      int p=6+i*16, length=checked((int)BitConverter.ToUInt32(ico,p+8)), offset=checked((int)BitConverter.ToUInt32(ico,p+12));
      if(length<8 || offset<6+count*16 || offset>ico.Length-length) throw new Exception("ICO image range invalid");
      Buffer.BlockCopy(ico,p,header,6+i*14,12);
      Buffer.BlockCopy(BitConverter.GetBytes((ushort)(701+i)),0,header,6+i*14+12,2);
      var frame=new byte[length]; Buffer.BlockCopy(ico,offset,frame,0,length); frames.Add(frame);
    }
    IntPtr module=Open(executable); List<Group> groups;
    try { groups=Groups(module); } finally { FreeLibrary(module); }
    if(groups.Count==0) groups.Add(new Group { Id=1, Language=0 });
    if(!verifyOnly) {
      IntPtr update=BeginUpdateResource(executable,false); if(update==IntPtr.Zero) throw Error();
      bool committed=false;
      try {
        foreach(ushort language in groups.Select(g=>g.Language).Concat(new ushort[]{0}).Distinct())
          for(int i=0;i<count;i++) Put(update,3,new IntPtr(701+i),language,frames[i]);
        foreach(var group in groups) {
          IntPtr name=group.Text==null ? new IntPtr(group.Id) : Marshal.StringToHGlobalUni(group.Text);
          try { Put(update,14,name,group.Language,header); } finally { if(group.Text!=null) Marshal.FreeHGlobal(name); }
        }
        bool ok=EndUpdateResource(update,false); committed=true; if(!ok) throw Error();
      } finally { if(!committed) EndUpdateResource(update,true); }
    }
    module=Open(executable);
    try {
      foreach(var group in groups) {
        IntPtr name=group.Text==null ? new IntPtr(group.Id) : Marshal.StringToHGlobalUni(group.Text);
        try {
          if(!Read(module,14,name,group.Language).SequenceEqual(header)) throw new Exception("EXE icon group mismatch");
          for(int i=0;i<count;i++) if(!Read(module,3,new IntPtr(701+i),group.Language).SequenceEqual(frames[i])) throw new Exception("EXE icon image mismatch");
        } finally { if(group.Text!=null) Marshal.FreeHGlobal(name); }
      }
    } finally { FreeLibrary(module); }
  }
}
'@
$taskExePath = (Resolve-Path -LiteralPath $Executable).Path
$taskIconPath = (Resolve-Path -LiteralPath $Icon).Path
[TraceryIconResource]::Process($taskExePath, $taskIconPath, $VerifyOnly.IsPresent)
Write-Output "EXE 图标资源校验通过：$taskExePath"
