package cnos

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	goruntime "runtime"
	"strings"
)

func readKeychain(entry string, env environment) (string, bool) {
	switch goruntime.GOOS {
	case "darwin":
		return runCommandTrimmed("security", []string{"find-generic-password", "-a", "cnos", "-s", entry, "-w"}, env)
	case "linux":
		return runCommandTrimmed("secret-tool", []string{"lookup", "service", "cnos", "account", entry}, env)
	case "windows":
		script := fmt.Sprintf(
			"Add-Type -AssemblyName System.Runtime.WindowsRuntime; [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] > $null; $vault = New-Object Windows.Security.Credentials.PasswordVault; $credential = $vault.Retrieve('cnos','%s'); $credential.RetrievePassword(); Write-Output $credential.Password",
			escapePowerShellSingleQuoted(entry),
		)
		return runCommandTrimmed("powershell", []string{"-NoProfile", "-Command", script}, env)
	default:
		return "", false
	}
}

func promptHidden(message string, env environment) (string, bool) {
	if !stdinIsInteractive() {
		return "", false
	}

	switch goruntime.GOOS {
	case "darwin", "linux":
		script := fmt.Sprintf("printf %%s %q >/dev/tty; stty -echo </dev/tty; IFS= read -r value </dev/tty; stty echo </dev/tty; printf '\\n' >/dev/tty; printf %%s \"$value\"", message)
		return runCommandTrimmed("sh", []string{"-c", script}, env)
	case "windows":
		script := fmt.Sprintf(
			"$p = Read-Host %q -AsSecureString; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($p); [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)",
			message,
		)
		return runCommandTrimmed("powershell", []string{"-NoProfile", "-Command", script}, env)
	default:
		return "", false
	}
}

func runCommandTrimmed(name string, args []string, env environment) (string, bool) {
	command := exec.Command(name, args...)
	command.Env = env.ProcessEnv()
	var stdout bytes.Buffer
	command.Stdout = &stdout
	if err := command.Run(); err != nil {
		return "", false
	}
	value := strings.TrimSpace(stdout.String())
	if value == "" {
		return "", false
	}
	return value, true
}

func stdinIsInteractive() bool {
	info, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

func escapePowerShellSingleQuoted(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}
