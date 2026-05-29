package cnos

import "errors"

var (
	ErrProjectionNotFound = errors.New("cnos: no server projection found")
	ErrMissingKey         = errors.New("cnos: missing config key")
)
