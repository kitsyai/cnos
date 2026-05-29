package cnos

import (
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadAuthoringSupportsGitBackedRemoteRoot(t *testing.T) {
	t.Parallel()

	repoRoot := t.TempDir()
	consumerRoot := t.TempDir()
	cacheDir := t.TempDir()

	writeAuthoringFile(t, filepath.Join(repoRoot, ".cnos", "cnos.yml"), []byte(`
version: 1
project:
  name: remote-config
workspaces:
  default: travel
  items:
    travel: {}
`))
	writeAuthoringFile(t, filepath.Join(repoRoot, ".cnos", "workspaces", "travel", "values", "app.yml"), []byte(`
app:
  name: remote-travel
server:
  port: 7703
`))

	runGit(t, repoRoot, "init")
	runGit(t, repoRoot, "config", "user.email", "cnos@example.com")
	runGit(t, repoRoot, "config", "user.name", "CNOS Test")
	runGit(t, repoRoot, "add", ".")
	runGit(t, repoRoot, "commit", "-m", "init-remote-config")
	runGit(t, repoRoot, "branch", "-M", "main")

	rootURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(repoRoot)}).String()
	writeAuthoringFile(t, filepath.Join(consumerRoot, ".cnosrc.yml"), []byte("root: git+"+rootURL+"#main:.cnos\nworkspace: travel\n"))

	runtime, err := Load(Options{
		WorkingDir:  consumerRoot,
		Environment: map[string]string{"CNOS_CACHE_DIR": cacheDir},
		SecretHome:  t.TempDir(),
	})
	if err != nil {
		t.Fatalf("load git-backed remote authoring root: %v", err)
	}

	name, ok, err := runtime.Value("app.name")
	if err != nil {
		t.Fatalf("read remote app.name: %v", err)
	}
	if !ok || name != "remote-travel" {
		t.Fatalf("expected remote app.name, got ok=%v value=%v", ok, name)
	}

	if !pathExists(filepath.Join(cacheDir, "roots")) {
		t.Fatalf("expected remote root cache to be created under %s", cacheDir)
	}
}

func runGit(t *testing.T, cwd string, args ...string) {
	t.Helper()

	command := exec.Command("git", args...)
	command.Dir = cwd
	command.Env = os.Environ()
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
}
