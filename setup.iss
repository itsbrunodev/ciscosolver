[Setup]
AppName=Cisco Solver
AppVersion=1.0.0
AppPublisher=itsbrunodev
AppPublisherURL=https://github.com/itsbrunodev/ciscosolver
DefaultDirName={autopf}\CiscoSolver
DefaultGroupName=Cisco Solver
UninstallDisplayIcon={app}\start.exe
OutputDir=installer
OutputBaseFilename=ciscosolver-setup
Compression=lzma2/fast
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
PrivilegesRequired=admin
WizardStyle=modern
DisableDirPage=no
AlwaysShowDirOnReadyPage=yes
MinVersion=10.0

[Messages]
FinishedLabel=Cisco Solver has been installed successfully.%n%nThe server will be available at http://localhost:6767 after launch.%n%nThe Cisco Solver browser extension is required to display answers in your browser.

[Tasks]
Name: "launchtype"; Description: "Launch mode:";
Name: "launchtype\visible"; Description: "Standard (visible window)"; Flags: exclusive
Name: "launchtype\hidden"; Description: "Background (hidden window)"; Flags: exclusive unchecked
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "dist\offline\start.exe";  DestDir: "{app}"; Flags: ignoreversion
Source: "dist\offline\server.cjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\offline\node.exe";   DestDir: "{app}"; Flags: ignoreversion
Source: "dist\offline\node_modules\*"; DestDir: "{app}\node_modules"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Cisco Solver";              Filename: "{app}\start.exe"; Tasks: launchtype\visible
Name: "{group}\Cisco Solver (Background)"; Filename: "{app}\start.exe"; Parameters: "--hidden"; Tasks: launchtype\hidden
Name: "{group}\Uninstall Cisco Solver";    Filename: "{uninstallexe}"
Name: "{commondesktop}\Cisco Solver";      Filename: "{app}\start.exe"; Tasks: desktopicon and launchtype\visible
Name: "{commondesktop}\Cisco Solver";      Filename: "{app}\start.exe"; Parameters: "--hidden"; Tasks: desktopicon and launchtype\hidden

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM start.exe /T";  Flags: runhidden; RunOnceId: "KillLauncher"
Filename: "taskkill"; Parameters: "/F /IM ollama.exe /T"; Flags: runhidden; RunOnceId: "KillOllama"
Filename: "taskkill"; Parameters: "/F /IM node.exe /T";   Flags: runhidden; RunOnceId: "KillNode"

[Run]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '$env:TEMP\OllamaSetup.exe'"""; \
  StatusMsg: "Downloading Ollama runtime..."; \
  Flags: runhidden waituntilterminated

Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Start-Process '$env:TEMP\OllamaSetup.exe' -ArgumentList '/S' -Wait"""; \
  StatusMsg: "Installing Ollama..."; \
  Flags: runhidden waituntilterminated

Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$env:OLLAMA_MODELS='{app}\ollama-models'; $env:OLLAMA_HOST='http://127.0.0.1:11435'; $srv = Start-Process '$env:LOCALAPPDATA\Programs\Ollama\ollama.exe' -ArgumentList 'serve' -PassThru -NoNewWindow; Start-Sleep 4; & '$env:LOCALAPPDATA\Programs\Ollama\ollama.exe' pull qwen2.5:7b-instruct-q4_K_M; Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue"""; \
  StatusMsg: "Downloading Qwen2.5-7B model (~4 GB, please wait)..."; \
  Flags: runhidden waituntilterminated

Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""New-Item -ItemType Directory -Force -Path '{app}\ollama' | Out-Null; Copy-Item '$env:LOCALAPPDATA\Programs\Ollama\ollama.exe' '{app}\ollama\ollama.exe' -Force; Copy-Item '$env:LOCALAPPDATA\Programs\Ollama\lib' '{app}\ollama\lib' -Recurse -Force"""; \
  StatusMsg: "Copying Ollama runtime to installation directory..."; \
  Flags: runhidden waituntilterminated

Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri 'https://huggingface.co/datasets/itsbrunodev/ciscosolver/resolve/main/model.zip' -OutFile '$env:TEMP\model.zip'"""; \
  StatusMsg: "Downloading embedding model (~550 MB)..."; \
  Flags: runhidden waituntilterminated

Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Expand-Archive -Path '$env:TEMP\model.zip' -DestinationPath '{app}' -Force; Remove-Item '$env:TEMP\model.zip' -Force"""; \
  StatusMsg: "Extracting embedding model..."; \
  Flags: runhidden waituntilterminated

Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""$ProgressPreference='SilentlyContinue'; New-Item -ItemType Directory -Force -Path '{app}\data' | Out-Null; Invoke-WebRequest -Uri 'https://huggingface.co/datasets/itsbrunodev/ciscosolver/resolve/main/vectors.msp' -OutFile '{app}\data\vectors.msp'"""; \
  StatusMsg: "Downloading vector index (~420 MB)..."; \
  Flags: runhidden waituntilterminated

Filename: "{app}\start.exe"; \
  Description: "Launch Cisco Solver"; \
  Flags: nowait postinstall skipifsilent; \
  Tasks: launchtype\visible

Filename: "{app}\start.exe"; \
  Parameters: "--hidden"; \
  Description: "Launch Cisco Solver in the background"; \
  Flags: nowait postinstall skipifsilent; \
  Tasks: launchtype\hidden

[Code]
function InitializeSetup(): Boolean;
var
  Msg: String;
begin
  Msg := 'Cisco Solver requires an internet connection during installation to download:' + #13#10;
  Msg := Msg + #13#10;
  Msg := Msg + '  - Ollama runtime' + #13#10;
  Msg := Msg + '  - Qwen2.5-7B language model (~4 GB)' + #13#10;
  Msg := Msg + '  - BGE-M3 embedding model (~3 GB)' + #13#10;
  Msg := Msg + '  - Vector search index (~420 MB)' + #13#10;
  Msg := Msg + #13#10;
  Msg := Msg + 'After installation the app runs fully offline.' + #13#10;
  Msg := Msg + 'Total download: approximately 13 GB. Please be patient.';

  if not WizardSilent then
    MsgBox(Msg, mbInformation, MB_OK);

  Result := True;
end;
