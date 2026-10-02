package desktop

import (
	"embed"
	"encoding/binary"
	"runtime"
)

//go:embed icons/*.png
var iconFS embed.FS

func icon(name string) []byte {
	b, _ := iconFS.ReadFile("icons/" + name)
	return b
}

// pngToICO wraps a PNG in an ICO container (Windows tray icons must be .ico; PNG payloads are valid since Vista).
func pngToICO(png []byte) []byte {
	if len(png) < 24 {
		return png
	}
	w, h := binary.BigEndian.Uint32(png[16:20]), binary.BigEndian.Uint32(png[20:24])
	out := make([]byte, 0, 22+len(png))
	out = binary.LittleEndian.AppendUint16(out, 0) // reserved
	out = binary.LittleEndian.AppendUint16(out, 1) // type: icon
	out = binary.LittleEndian.AppendUint16(out, 1) // image count
	dim := func(v uint32) byte {
		if v >= 256 {
			return 0
		}
		return byte(v)
	}
	out = append(out, dim(w), dim(h), 0, 0)
	out = binary.LittleEndian.AppendUint16(out, 1)  // planes
	out = binary.LittleEndian.AppendUint16(out, 32) // bits per pixel
	out = binary.LittleEndian.AppendUint32(out, uint32(len(png)))
	out = binary.LittleEndian.AppendUint32(out, 22) // image offset
	return append(out, png...)
}

// trayIcon returns the icon bytes for the current system and state.
func trayIcon(on bool) (template, regular []byte) {
	switch runtime.GOOS {
	case "darwin":
		name := "trayOffTemplate@2x.png"
		if on {
			name = "trayOnTemplate@2x.png"
		}
		b := icon(name)
		return b, b // template images: the system tints them
	case "windows":
		name := "tray-off@2x.png"
		if on {
			name = "tray-on@2x.png"
		}
		b := pngToICO(icon(name))
		return b, b
	default:
		name := "tray-off@2x.png"
		if on {
			name = "tray-on@2x.png"
		}
		b := icon(name)
		return b, b
	}
}
