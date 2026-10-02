// Package types is the contract between the engine and the UI/extension.
// JSON names and shapes match src/shared/types.ts exactly: the React UI and the
// browser extension talk to this engine unchanged.
package types

type ProxyEndpoint struct {
	Protocol string `json:"protocol"` // http | https | socks5
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

type Account struct {
	ID        string `json:"id"`
	Provider  string `json:"provider"` // "dataimpulse"
	Name      string `json:"name"`
	Protocol  string `json:"protocol"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Username  string `json:"username"` // base login, targeting stripped
	Password  string `json:"password"`
	CreatedAt int64  `json:"createdAt"`
}

type IPInfo struct {
	IP          string `json:"ip"`
	CountryCode string `json:"countryCode,omitempty"`
	Country     string `json:"country,omitempty"`
	Region      string `json:"region,omitempty"`
	City        string `json:"city,omitempty"`
	ISP         string `json:"isp,omitempty"`
}

type ExitCheck struct {
	At        int64   `json:"at"`
	OK        bool    `json:"ok"`
	LatencyMs int64   `json:"latencyMs,omitempty"`
	Info      *IPInfo `json:"info,omitempty"`
	Error     string  `json:"error,omitempty"`
	// auth | unreachable | timeout | refused | protocol | target | lookup
	ErrorCode string `json:"errorCode,omitempty"`
}

// Exit is the union of ProviderExit (Kind "provider") and ProxyExit (Kind "proxy").
type Exit struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	CreatedAt int64      `json:"createdAt"`
	LastCheck *ExitCheck `json:"lastCheck,omitempty"`
	Port      int        `json:"port,omitempty"` // fixed local port
	Kind      string     `json:"kind"`           // provider | proxy

	// provider
	AccountID        string `json:"accountId,omitempty"`
	Mode             string `json:"mode,omitempty"` // sticky | rotating
	Country          string `json:"country,omitempty"`
	City             string `json:"city,omitempty"`
	Session          string `json:"session,omitempty"`
	SessionMinutes   int    `json:"sessionMinutes,omitempty"`
	SessionStartedAt int64  `json:"sessionStartedAt,omitempty"`

	// proxy
	Proxy *ProxyEndpoint `json:"proxy,omitempty"`
}

type LanAuth struct {
	Enabled  bool   `json:"enabled"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type Settings struct {
	GatewayPort       int      `json:"gatewayPort"`
	AllowLan          bool     `json:"allowLan"`
	LanAuth           LanAuth  `json:"lanAuth"`
	SystemProxy       bool     `json:"systemProxy"`
	DropOnSwitch      bool     `json:"dropOnSwitch"`
	AutoRotateMinutes int      `json:"autoRotateMinutes"`
	Bypass            []string `json:"bypass"`
	StartConnected    bool     `json:"startConnected"`
	LaunchAtLogin     bool     `json:"launchAtLogin"`
	Theme             string   `json:"theme"` // system | light | dark
}

type Usage struct {
	Up    int64 `json:"up"`
	Down  int64 `json:"down"`
	Since int64 `json:"since"`
}

type UpstreamError struct {
	At      int64  `json:"at"`
	Message string `json:"message"`
}

type AppRule struct {
	ExitID *string `json:"exitId"` // null = follow the app
}

type UpdateState struct {
	Status     string `json:"status"` // idle|checking|none|available|downloading|ready|error
	Version    string `json:"version,omitempty"`
	Progress   int    `json:"progress,omitempty"`
	Error      string `json:"error,omitempty"`
	CanInstall bool   `json:"canInstall"`
	CheckedAt  int64  `json:"checkedAt,omitempty"`
}

type AppState struct {
	Version           string             `json:"version"`
	Platform          string             `json:"platform"` // darwin | win32 | linux (Node names, the UI branches on them)
	Shell             string             `json:"shell"`    // desktop | web
	DataDir           string             `json:"dataDir"`
	Status            string             `json:"status"` // off | connecting | on | error
	StatusError       string             `json:"statusError,omitempty"`
	SystemProxyActive bool               `json:"systemProxyActive"`
	SystemProxyError  string             `json:"systemProxyError,omitempty"`
	ActiveExitID      *string            `json:"activeExitId"`
	Accounts          []Account          `json:"accounts"`
	Exits             []Exit             `json:"exits"`
	Settings          Settings           `json:"settings"`
	Checking          []string           `json:"checking"`
	LanAddresses      []string           `json:"lanAddresses"`
	Usage             Usage              `json:"usage"`
	UpstreamError     *UpstreamError     `json:"upstreamError,omitempty"`
	PinnedErrors      map[string]string  `json:"pinnedErrors"`
	ExtensionDir      string             `json:"extensionDir"`
	AppRules          map[string]AppRule `json:"appRules"`
	Update            *UpdateState       `json:"update,omitempty"`
}

type InstalledApp struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Path      string   `json:"path"`
	Engine    string   `json:"engine"` // electron | cef | chromium | native
	Method    string   `json:"method"` // launch | inside | system
	Hint      string   `json:"hint,omitempty"`
	Running   bool     `json:"running"`
	ProxyPort *int     `json:"proxyPort"`
	Rule      *AppRule `json:"rule"`
}

type BrowserProfile struct {
	Browser     string `json:"browser"` // chrome | edge | brave | chromium | firefox
	BrowserName string `json:"browserName"`
	Dir         string `json:"dir"`
	Name        string `json:"name"`
	Email       string `json:"email,omitempty"`
	Kind        string `json:"kind"`      // extension | prefs
	Extension   string `json:"extension"` // on | disabled | missing
	ProxyPort   *int   `json:"proxyPort"`
	Running     bool   `json:"running"`
}

type GatewayStatusExit struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Port        *int   `json:"port"`
	IP          string `json:"ip,omitempty"`
	CountryCode string `json:"countryCode,omitempty"`
	City        string `json:"city,omitempty"`
	LatencyMs   int64  `json:"latencyMs,omitempty"`
	Mode        string `json:"mode"`
}

// GatewayStatus is served to the browser extension at /proxy-app.json. No secrets.
type GatewayStatus struct {
	App          string              `json:"app"` // "proxy-app"
	Version      string              `json:"version"`
	Connected    bool                `json:"connected"`
	Port         int                 `json:"port"`
	ActiveExitID *string             `json:"activeExitId"`
	Exits        []GatewayStatusExit `json:"exits"`
}

type TrafficStats struct {
	At       int64 `json:"at"`
	UpRate   int64 `json:"upRate"`
	DownRate int64 `json:"downRate"`
	Up       int64 `json:"up"`
	Down     int64 `json:"down"`
	Active   int   `json:"active"`
}

type ActivityEntry struct {
	ID         int64   `json:"id"`
	At         int64   `json:"at"`
	Kind       string  `json:"kind"` // http | connect | socks
	Client     string  `json:"client"`
	Host       string  `json:"host"`
	Port       int     `json:"port"`
	ExitID     *string `json:"exitId"`
	Direct     bool    `json:"direct"`
	Up         int64   `json:"up"`
	Down       int64   `json:"down"`
	Status     string  `json:"status"` // open | closed | failed
	DurationMs int64   `json:"durationMs,omitempty"`
	Error      string  `json:"error,omitempty"`
}

type ParsedProxy struct {
	ProxyEndpoint
	Provider string `json:"provider"` // "" is sent as null by the API layer
	Country  string `json:"country,omitempty"`
	City     string `json:"city,omitempty"`
}

// Control API inputs.
type AddProxiesInput struct {
	Text           string  `json:"text"`
	Mode           string  `json:"mode"`
	Country        *string `json:"country"`
	City           *string `json:"city"`
	SessionMinutes int     `json:"sessionMinutes"`
	Count          *int    `json:"count"`
}

type CreateExitsInput struct {
	AccountID      string `json:"accountId"`
	Mode           string `json:"mode"`
	Country        string `json:"country"`
	City           string `json:"city"`
	SessionMinutes int    `json:"sessionMinutes"`
	Count          int    `json:"count"`
}

type TestProxyInput struct {
	Text    string  `json:"text"`
	Mode    string  `json:"mode"`
	Country *string `json:"country"`
	City    *string `json:"city"`
}

type TestProxyResult struct {
	Parsed *ParsedProxy `json:"parsed"`
	Check  ExitCheck    `json:"check"`
}
