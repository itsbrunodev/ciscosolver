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
Name: "{commonprograms}\Cisco Solver\Cisco Solver";              Filename: "{app}\start.exe"; Tasks: launchtype\visible
Name: "{commonprograms}\Cisco Solver\Cisco Solver (Background)"; Filename: "{app}\start.exe"; Parameters: "--hidden"; Tasks: launchtype\hidden
Name: "{commonprograms}\Cisco Solver\Uninstall Cisco Solver";    Filename: "{uninstallexe}"
Name: "{commondesktop}\Cisco Solver"; Filename: "{app}\start.exe"; Tasks: desktopicon and launchtype\visible
Name: "{commondesktop}\Cisco Solver"; Filename: "{app}\start.exe"; Parameters: "--hidden"; Tasks: desktopicon and launchtype\hidden

[UninstallRun]
Filename: "taskkill"; Parameters: "/F /IM start.exe /T";  Flags: runhidden; RunOnceId: "KillLauncher"
Filename: "taskkill"; Parameters: "/F /IM ollama.exe /T"; Flags: runhidden; RunOnceId: "KillOllama"
Filename: "taskkill"; Parameters: "/F /IM node.exe /T";   Flags: runhidden; RunOnceId: "KillNode"

[Run]
Filename: "{app}\start.exe"; Description: "Launch Cisco Solver"; Flags: nowait postinstall skipifsilent; Tasks: launchtype\visible
Filename: "{app}\start.exe"; Parameters: "--hidden"; Description: "Launch Cisco Solver in the background"; Flags: nowait postinstall skipifsilent; Tasks: launchtype\hidden

[Code]
var
  DownloadPage: TDownloadWizardPage;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(
    'Downloading required assets',
    'Please wait while the required components are downloaded. This may take a while depending on your internet connection.',
    nil
  );
end;

procedure RunPowerShell(Script: String; StatusMsg: String);
var
  ScriptPath: String;
  ResultCode: Integer;
  AppDir: String;
begin
  AppDir := ExpandConstant('{app}');
  ScriptPath := AppDir + '\~install-step.ps1';
  WizardForm.StatusLabel.Caption := StatusMsg;
  SaveStringToFile(ScriptPath, Script, False);
  Exec(
    'powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -File "' + ScriptPath + '"',
    AppDir,
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode
  );
  DeleteFile(ScriptPath);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  AppDir: String;
  NL: String;
  Script: String;
begin
  if CurStep = ssInstall then
  begin
    { ── Phase 1: Download with progress bar ─────────────────────────────── }
    DownloadPage.Clear;
    DownloadPage.Add(
      'https://ollama.com/download/OllamaSetup.exe',
      'OllamaSetup.exe',
      ''
    );
    DownloadPage.Add(
      'https://huggingface.co/datasets/itsbrunodev/ciscosolver/resolve/main/model.zip',
      'model.zip',
      ''
    );
    DownloadPage.Add(
      'https://huggingface.co/datasets/itsbrunodev/ciscosolver/resolve/main/vectors.msp',
      'vectors.msp',
      ''
    );
    DownloadPage.Show;
    try
      DownloadPage.Download;
    finally
      DownloadPage.Hide;
    end;
  end;

  if CurStep = ssPostInstall then
  begin
    AppDir := ExpandConstant('{app}');
    NL := Chr(13) + Chr(10);

    { Install Ollama silently }
    Script := 'Start-Process "' + ExpandConstant('{tmp}') + '\OllamaSetup.exe" -ArgumentList "/S" -Wait' + NL;
    RunPowerShell(Script, 'Installing Ollama...');

    { Pull Qwen model into app dir }
    Script := '$env:OLLAMA_MODELS = "' + AppDir + '\ollama-models"' + NL;
    Script := Script + '$env:OLLAMA_HOST = "http://127.0.0.1:11435"' + NL;
    Script := Script + '$ollamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"' + NL;
    Script := Script + 'New-Item -ItemType Directory -Force -Path "' + AppDir + '\ollama-models" | Out-Null' + NL;
    Script := Script + '$srv = Start-Process $ollamaExe -ArgumentList "serve" -PassThru -NoNewWindow' + NL;
    Script := Script + 'Start-Sleep 5' + NL;
    Script := Script + '& $ollamaExe pull qwen2.5:7b-instruct-q4_K_M' + NL;
    Script := Script + 'Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue' + NL;
    Script := Script + 'Start-Sleep 2' + NL;
    RunPowerShell(Script, 'Downloading Qwen2.5-7B model (~4 GB, please wait)...');

    { Copy Ollama runtime into app dir }
    Script := 'New-Item -ItemType Directory -Force -Path "' + AppDir + '\ollama" | Out-Null' + NL;
    Script := Script + 'Copy-Item "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe" "' + AppDir + '\ollama\ollama.exe" -Force' + NL;
    Script := Script + 'Copy-Item "$env:LOCALAPPDATA\Programs\Ollama\lib" "' + AppDir + '\ollama\lib" -Recurse -Force' + NL;
    RunPowerShell(Script, 'Copying Ollama runtime...');

    { Extract model.zip into model/ }
    Script := '$ProgressPreference = "SilentlyContinue"' + NL;
    Script := Script + 'Expand-Archive -Path "' + ExpandConstant('{tmp}') + '\model.zip" -DestinationPath "$env:TEMP\model-extract" -Force' + NL;
    Script := Script + 'New-Item -ItemType Directory -Force -Path "' + AppDir + '\model" | Out-Null' + NL;
    Script := Script + 'Copy-Item "$env:TEMP\model-extract\*" "' + AppDir + '\model" -Recurse -Force' + NL;
    Script := Script + 'Remove-Item "$env:TEMP\model-extract" -Recurse -Force' + NL;
    RunPowerShell(Script, 'Extracting embedding model...');

    { Move vectors.msp into data/ }
    Script := 'New-Item -ItemType Directory -Force -Path "' + AppDir + '\data" | Out-Null' + NL;
    Script := Script + 'Copy-Item "' + ExpandConstant('{tmp}') + '\vectors.msp" "' + AppDir + '\data\vectors.msp" -Force' + NL;
    RunPowerShell(Script, 'Installing vector index...');
  end;
end;

function OnDownloadProgress(const Url, Filename: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

function InitializeSetup(): Boolean;
var
  Msg: String;
  NL: String;
begin
  NL := Chr(13) + Chr(10);
  Msg := 'Cisco Solver requires an internet connection during installation to download:' + NL;
  Msg := Msg + NL;
  Msg := Msg + '  - Ollama runtime' + NL;
  Msg := Msg + '  - Qwen2.5-7B language model (~4 GB)' + NL;
  Msg := Msg + '  - BGE-M3 embedding model (~3 GB)' + NL;
  Msg := Msg + '  - Vector search index (~420 MB)' + NL;
  Msg := Msg + NL;
  Msg := Msg + 'After installation the app runs fully offline.' + NL;
  Msg := Msg + 'Total download: approximately 13 GB. Please be patient.';

  if not WizardSilent then
    MsgBox(Msg, mbInformation, MB_OK);

  Result := True;
end;
