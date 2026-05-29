package cnos

import (
	"os"
	"strings"
)

type environment struct {
	override map[string]string
	useOS    bool
}

func newEnvironment(values map[string]string) environment {
	if values == nil {
		return environment{useOS: true}
	}
	return environment{override: values}
}

func (env environment) Get(key string) (string, bool) {
	if env.useOS {
		return os.LookupEnv(key)
	}
	value, ok := env.override[key]
	return value, ok
}

func (env environment) ProcessEnv() []string {
	values := map[string]string{}
	for _, item := range os.Environ() {
		key, value, ok := strings.Cut(item, "=")
		if ok {
			values[key] = value
		}
	}
	if env.useOS {
		return mapToEnv(values)
	}
	for key, value := range env.override {
		values[key] = value
	}
	return mapToEnv(values)
}

func mapToEnv(values map[string]string) []string {
	envList := make([]string, 0, len(values))
	for key, value := range values {
		envList = append(envList, key+"="+value)
	}
	return envList
}
