// Package bigproxy embeds the built UI and the browser extension into the binary.
// Build the UI first (npm run build:ui); `go build` fails without dist/ui.
package bigproxy

import (
	"embed"
	"io/fs"
)

//go:embed all:dist/ui
var uiFiles embed.FS

//go:embed all:extension
var extensionFiles embed.FS

// UI is the web UI (index.html at its root).
func UI() fs.FS {
	sub, err := fs.Sub(uiFiles, "dist/ui")
	if err != nil {
		panic(err)
	}
	return sub
}

// Extension is the browser extension (manifest.json at its root).
func Extension() fs.FS {
	sub, err := fs.Sub(extensionFiles, "extension")
	if err != nil {
		panic(err)
	}
	return sub
}
