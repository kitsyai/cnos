package cnos

import (
	"os"
	"path/filepath"
)

const projectionFileName = ".cnos-server.json"

func resolveWorkingDir(workingDir string) (string, error) {
	if workingDir != "" {
		return filepath.Abs(workingDir)
	}

	return os.Getwd()
}

func resolvePathFromWorkingDir(workingDir, target string) (string, error) {
	if filepath.IsAbs(target) {
		return target, nil
	}

	base, err := resolveWorkingDir(workingDir)
	if err != nil {
		return "", err
	}

	return filepath.Join(base, target), nil
}

func fileExists(target string) bool {
	info, err := os.Stat(target)
	return err == nil && !info.IsDir()
}

func pathExists(target string) bool {
	_, err := os.Stat(target)
	return err == nil
}

func findProjectionPath(workingDir string) (string, error) {
	cwd, err := resolveWorkingDir(workingDir)
	if err != nil {
		return "", err
	}

	directCandidate := filepath.Join(cwd, projectionFileName)
	if fileExists(directCandidate) {
		return directCandidate, nil
	}

	current := cwd
	for depth := 0; depth <= 3; depth += 1 {
		rcCandidate := filepath.Join(current, ".cnosrc.yml")
		if fileExists(rcCandidate) {
			projectionCandidate := filepath.Join(current, projectionFileName)
			if fileExists(projectionCandidate) {
				return projectionCandidate, nil
			}
		}

		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}

	return "", nil
}
