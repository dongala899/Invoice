Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptsDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectRoot = fso.GetParentFolderName(scriptsDir)
shell.CurrentDirectory = projectRoot
shell.Run Chr(34) & projectRoot & "\Launch Shaker.cmd" & Chr(34) & " --server", 0, False
