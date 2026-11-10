; Установщик PolyPlayer (для текущего пользователя, права администратора не нужны).
; Обычный запуск — с окнами; /S — тихая установка (так ставятся обновления), после неё программа запускается сама.
; Файл в UTF-8 с BOM, makensis вызывается с /INPUTCHARSET UTF8: без этого makensis на Windows читает
; русский текст в кодировке системы и в окнах установщика получаются кракозябры (issue #1).
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
!addplugindir /x86-unicode "build\nsis-plugins\x86-unicode"
!include "MUI2.nsh"
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!define APPNAME "PolyPlayer"
!define AUMID "com.polyplayer.app"
!define EXE "PolyPlayer.exe"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\PolyPlayer"
!define RUNKEY "Software\Microsoft\Windows\CurrentVersion\Run"

Name "${APPNAME}"
OutFile "dist\PolyPlayer-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\PolyPlayer"
InstallDirRegKey HKCU "${UNKEY}" "InstallLocation"
RequestExecutionLevel user
BrandingText "PolyPlayer ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=1049 "ProductName" "PolyPlayer"
VIAddVersionKey /LANG=1049 "FileDescription" "Установка PolyPlayer"
VIAddVersionKey /LANG=1049 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1049 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1049 "CompanyName" "PolyPlayer"
VIAddVersionKey /LANG=1049 "LegalCopyright" "PolyPlayer"

!define MUI_ICON "build\icon.ico"
!define MUI_UNICON "build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Установка PolyPlayer ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Многопоточный аудиоплеер для мероприятий: плавные переходы, горячие клавиши, расписание и пульт Stream Deck.$\r$\n$\r$\nЕсли PolyPlayer сейчас открыт, установщик его закроет, и музыка остановится. Потоки и расписание сохранятся.$\r$\n$\r$\nНажмите «Установить»."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Запустить PolyPlayer"
!define MUI_FINISHPAGE_RUN_FUNCTION RunApp
!define MUI_FINISHPAGE_TEXT "PolyPlayer установлен. Ярлык есть на рабочем столе и в меню «Пуск».$\r$\n$\r$\nЕсли закрыть окно программы, музыка не прервётся: PolyPlayer продолжит работать в трее — справа на панели задач, возле часов."

!define MUI_PAGE_CUSTOMFUNCTION_SHOW WelcomeShow
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"

Function WelcomeShow
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Установить"
FunctionEnd

Function RunApp
  Exec '"$INSTDIR\${EXE}"'
FunctionEnd

; после тихой установки (обновление) — запускаем программу снова
Function .onInstSuccess
  IfSilent 0 +2
    Exec '"$INSTDIR\${EXE}" --updated'
FunctionEnd

!macro CloseApps
  nsExec::Exec 'taskkill /IM "${EXE}" /T /F'
  Pop $0
  nsExec::Exec 'taskkill /IM "SWP Player.exe" /T /F'
  Pop $0
  Sleep 1500
!macroend

Section "Install"
  !insertmacro CloseApps
  ; ---- убираем старую программу SWP Player (её настройки PolyPlayer перенесёт сам) ----
  Delete "$DESKTOP\SWP Player.lnk"
  Delete "$SMPROGRAMS\SWP Player.lnk"
  DeleteRegValue HKCU "${RUNKEY}" "pl.slowowiary.swpplayer"
  DeleteRegValue HKCU "${RUNKEY}" "SWP Player"
  DeleteRegValue HKCU "${RUNKEY}" "electron.app.SWP Player"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SWPPlayer"
  RMDir /r "$LOCALAPPDATA\Programs\SWP Player"

  ; ---- ставим PolyPlayer ----
  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "dist\win-unpacked\*.*"
  WriteUninstaller "$INSTDIR\Uninstall PolyPlayer.exe"

  IfSilent shortcuts_done 0
  CreateShortCut "$DESKTOP\PolyPlayer.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  WinShell::SetLnkAUMI "$DESKTOP\PolyPlayer.lnk" "${AUMID}"
  shortcuts_done:
  CreateShortCut "$SMPROGRAMS\PolyPlayer.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  WinShell::SetLnkAUMI "$SMPROGRAMS\PolyPlayer.lnk" "${AUMID}"

  WriteRegStr HKCU "${UNKEY}" "DisplayName" "PolyPlayer"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "PolyPlayer"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Uninstall PolyPlayer.exe"'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall PolyPlayer.exe" /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" $0
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${EXE}" /T /F'
  Pop $0
  Sleep 1000
  Delete "$DESKTOP\PolyPlayer.lnk"
  Delete "$SMPROGRAMS\PolyPlayer.lnk"
  DeleteRegValue HKCU "${RUNKEY}" "${AUMID}"
  DeleteRegValue HKCU "${RUNKEY}" "PolyPlayer"
  DeleteRegValue HKCU "${RUNKEY}" "electron.app.PolyPlayer"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${AUMID}"
  DeleteRegKey HKCU "${UNKEY}"
  RMDir /r "$INSTDIR"
  ; потоки и расписание (%APPDATA%\PolyPlayer) не трогаем — пригодятся при переустановке
SectionEnd
