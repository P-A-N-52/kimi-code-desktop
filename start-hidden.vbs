Option Explicit

Dim shell
Dim fso
Dim scriptDir
Dim startBat

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
startBat = fso.BuildPath(scriptDir, "start.bat")

shell.CurrentDirectory = scriptDir
shell.Run """" & startBat & """", 0, False
