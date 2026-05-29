package cnos

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type parsedGitURI struct {
	URI       string
	CloneURL  string
	Ref       string
	Subpath   string
	Transport string
}

type remoteRootCacheMetadata struct {
	URI            string `json:"uri"`
	CloneURL       string `json:"cloneUrl"`
	Ref            string `json:"ref"`
	Subpath        string `json:"subpath"`
	ResolvedCommit string `json:"resolvedCommit"`
	CachedAt       string `json:"cachedAt"`
	IsImmutable    bool   `json:"isImmutable"`
}

type remoteRootCachePaths struct {
	CacheRoot string
	CacheDir  string
	RepoDir   string
	MetaPath  string
}

type resolvedAuthoringRoot struct {
	ManifestRoot string
	Remote       bool
}

func resolveRootURI(rootURI, cnosrcDir string, options Options, env environment) (resolvedAuthoringRoot, error) {
	switch {
	case strings.HasPrefix(rootURI, "git+"):
		return resolveGitRoot(rootURI, options, env)
	case strings.HasPrefix(rootURI, "cnos://"):
		return resolvedAuthoringRoot{}, fmt.Errorf("cnos: the cnos:// remote root protocol is reserved but not implemented yet. Use git+https:// or git+ssh:// for now")
	default:
		rootPath, err := resolvePathFromWorkingDir(cnosrcDir, rootURI)
		if err != nil {
			return resolvedAuthoringRoot{}, err
		}
		manifestRoot, err := resolveCnosRoot(rootPath)
		if err != nil {
			return resolvedAuthoringRoot{}, err
		}
		return resolvedAuthoringRoot{ManifestRoot: manifestRoot}, nil
	}
}

func parseGitRootURI(uri string) (parsedGitURI, error) {
	if !strings.HasPrefix(uri, "git+") || !strings.Contains(uri, "://") {
		return parsedGitURI{}, fmt.Errorf("cnos: unsupported git root URI: %s", uri)
	}

	withoutPrefix := strings.TrimPrefix(uri, "git+")
	hashIndex := strings.IndexByte(withoutPrefix, '#')
	if hashIndex < 0 {
		return parsedGitURI{}, fmt.Errorf("cnos: git root URI must include a #ref (tag, branch, or commit). Got: %s", uri)
	}

	cloneURL := withoutPrefix[:hashIndex]
	fragment := withoutPrefix[hashIndex+1:]
	separatorIndex := strings.IndexByte(fragment, ':')
	ref := strings.TrimSpace(fragment)
	subpath := ".cnos"
	if separatorIndex >= 0 {
		ref = strings.TrimSpace(fragment[:separatorIndex])
		subpath = strings.TrimSpace(fragment[separatorIndex+1:])
		if subpath == "" {
			subpath = ".cnos"
		}
	}
	if cloneURL == "" || ref == "" {
		return parsedGitURI{}, fmt.Errorf("cnos: git root URI must include both a clone URL and #ref. Got: %s", uri)
	}

	protocol := cloneURL
	if schemeIndex := strings.Index(protocol, "://"); schemeIndex >= 0 {
		protocol = protocol[:schemeIndex]
	}

	transport := "custom"
	switch protocol {
	case "https":
		transport = "https"
	case "ssh":
		transport = "ssh"
	case "file":
		transport = "file"
	}

	return parsedGitURI{
		URI:       uri,
		CloneURL:  cloneURL,
		Ref:       ref,
		Subpath:   subpath,
		Transport: transport,
	}, nil
}

func resolveGitRoot(rootURI string, options Options, env environment) (resolvedAuthoringRoot, error) {
	parsed, err := parseGitRootURI(rootURI)
	if err != nil {
		return resolvedAuthoringRoot{}, err
	}

	cachePaths, err := resolveRemoteRootCachePaths(rootURI, env)
	if err != nil {
		return resolvedAuthoringRoot{}, err
	}

	metadata, _ := readRemoteRootCacheMetadata(cachePaths.MetaPath)
	immutable := isImmutableGitRef(parsed.Ref)
	cacheFresh := isRemoteRootCacheFresh(metadata, parsed.Ref, rootURI, options, env)

	if !cacheFresh {
		if err := ensureGitCheckout(parsed, cachePaths.RepoDir, env); err != nil {
			authHint := " Check the URL and your git credential helper or token setup."
			if parsed.Transport == "ssh" {
				authHint = " Check your SSH key and git access."
			}
			return resolvedAuthoringRoot{}, fmt.Errorf("cnos: failed to resolve remote git root %s. %w%s", rootURI, err, authHint)
		}

		resolvedCommit, err := runGitCommand([]string{"-C", cachePaths.RepoDir, "rev-parse", "HEAD"}, env)
		if err != nil {
			return resolvedAuthoringRoot{}, err
		}
		if err := writeRemoteRootCacheMetadata(cachePaths.MetaPath, remoteRootCacheMetadata{
			URI:            rootURI,
			CloneURL:       parsed.CloneURL,
			Ref:            parsed.Ref,
			Subpath:        parsed.Subpath,
			ResolvedCommit: resolvedCommit,
			CachedAt:       time.Now().UTC().Format(time.RFC3339),
			IsImmutable:    immutable,
		}); err != nil {
			return resolvedAuthoringRoot{}, err
		}
	}

	manifestRoot := filepath.Join(cachePaths.RepoDir, parsed.Subpath)
	if !fileExists(filepath.Join(manifestRoot, "cnos.yml")) {
		return resolvedAuthoringRoot{}, fmt.Errorf("cnos: git root %s resolved to %s but no cnos.yml was found there. Check the :subpath segment", rootURI, manifestRoot)
	}

	return resolvedAuthoringRoot{
		ManifestRoot: manifestRoot,
		Remote:       true,
	}, nil
}

func resolveRemoteRootCachePaths(uri string, env environment) (remoteRootCachePaths, error) {
	cacheRoot, err := resolveRemoteRootCacheRoot(env)
	if err != nil {
		return remoteRootCachePaths{}, err
	}

	cacheDir := filepath.Join(cacheRoot, "roots", createRemoteRootCacheKey(uri))
	return remoteRootCachePaths{
		CacheRoot: cacheRoot,
		CacheDir:  cacheDir,
		RepoDir:   filepath.Join(cacheDir, "repo"),
		MetaPath:  filepath.Join(cacheDir, ".cnos-cache-meta.json"),
	}, nil
}

func resolveRemoteRootCacheRoot(env environment) (string, error) {
	if value, ok := env.Get("CNOS_CACHE_DIR"); ok && strings.TrimSpace(value) != "" {
		return expandHomePath(value)
	}
	return expandHomePath("~/.cnos/cache")
}

func createRemoteRootCacheKey(uri string) string {
	sum := sha256.Sum256([]byte(uri))
	return hex.EncodeToString(sum[:])
}

func readRemoteRootCacheMetadata(path string) (*remoteRootCacheMetadata, error) {
	source, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var metadata remoteRootCacheMetadata
	if err := json.Unmarshal(source, &metadata); err != nil {
		return nil, err
	}
	return &metadata, nil
}

func writeRemoteRootCacheMetadata(path string, metadata remoteRootCacheMetadata) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	payload, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	return os.WriteFile(path, payload, 0o644)
}

func isImmutableGitRef(ref string) bool {
	if matched := semverTagPattern.MatchString(ref); matched {
		return true
	}
	return commitSHAPattern.MatchString(ref)
}

func isRemoteRootCacheFresh(metadata *remoteRootCacheMetadata, ref, uri string, options Options, env environment) bool {
	if metadata == nil || options.ForceRefresh {
		return false
	}
	if metadata.URI != uri || metadata.Ref != ref {
		return false
	}
	if metadata.IsImmutable {
		return true
	}

	ttlSeconds := resolveRemoteRootCacheTTLSeconds(options, env)
	if ttlSeconds <= 0 {
		return false
	}

	cachedAt, err := time.Parse(time.RFC3339, metadata.CachedAt)
	if err != nil {
		return false
	}
	return time.Since(cachedAt) <= time.Duration(ttlSeconds)*time.Second
}

func resolveRemoteRootCacheTTLSeconds(options Options, env environment) int {
	if options.CacheTTLSeconds > 0 {
		return options.CacheTTLSeconds
	}
	if options.CacheTTLSeconds == 0 && strings.TrimSpace(options.CacheMode) == "build" {
		return 0
	}
	if value, ok := env.Get("CNOS_CACHE_TTL"); ok && strings.TrimSpace(value) != "" {
		var ttl int
		if _, err := fmt.Sscanf(value, "%d", &ttl); err == nil && ttl >= 0 {
			return ttl
		}
	}

	switch strings.TrimSpace(options.CacheMode) {
	case "build":
		return 0
	case "dev":
		return 30
	default:
		return 300
	}
}

func ensureGitCheckout(parsed parsedGitURI, repoDir string, env environment) error {
	hasRepo := pathExists(filepath.Join(repoDir, ".git"))
	if !hasRepo {
		if err := os.MkdirAll(filepath.Dir(repoDir), 0o755); err != nil {
			return err
		}
		if _, err := runGitCommand([]string{"clone", "--no-checkout", parsed.CloneURL, repoDir}, env); err != nil {
			return err
		}
	} else if _, err := runGitCommand([]string{"-C", repoDir, "remote", "set-url", "origin", parsed.CloneURL}, env); err != nil {
		return err
	}

	if _, err := runGitCommand([]string{"-C", repoDir, "fetch", "--tags", "--force", "origin"}, env); err != nil {
		return err
	}
	if _, err := runGitCommand([]string{"-C", repoDir, "checkout", "--force", parsed.Ref}, env); err != nil {
		return err
	}
	if _, err := runGitCommand([]string{"-C", repoDir, "clean", "-fdx"}, env); err != nil {
		return err
	}
	return nil
}

func runGitCommand(args []string, env environment) (string, error) {
	command := exec.Command("git", args...)
	command.Env = env.ProcessEnv()
	output, err := command.CombinedOutput()
	if err == nil {
		return strings.TrimSpace(string(output)), nil
	}
	text := strings.TrimSpace(string(output))
	if text == "" {
		text = err.Error()
	}
	return "", fmt.Errorf("git command failed: %s", text)
}

var (
	semverTagPattern = regexp.MustCompile(`^v?\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$`)
	commitSHAPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)
)
