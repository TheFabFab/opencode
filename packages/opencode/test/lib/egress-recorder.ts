import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { mock } from "bun:test"
import WsPackage from "ws"

// Records the host of every outbound connection attempt at several layers.
// Import it before any code under test so nothing captures an unwrapped binding.
export const egress = { hosts: [] as string[] }

const hostOf = (input: unknown): string => {
  if (typeof input === "string") return input.includes("://") ? new URL(input).hostname : input
  if (input instanceof URL) return input.hostname
  if (typeof Request !== "undefined" && input instanceof Request) return new URL(input.url).hostname
  const options = input as { hostname?: string; host?: string } | undefined
  return (options?.hostname ?? options?.host ?? "unknown").replace(/:\d+$/, "")
}

const record = (input: unknown) => egress.hosts.push(hostOf(input))

const originalFetch = globalThis.fetch
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  record(input)
  return originalFetch(input, init)
}) as typeof fetch

const OriginalWebSocket = globalThis.WebSocket
globalThis.WebSocket = new Proxy(OriginalWebSocket, {
  construct(target, args) {
    record(args[0])
    return Reflect.construct(target, args)
  },
})

for (const mod of [http, https]) {
  const request = mod.request
  const get = mod.get
  mod.request = ((...args: unknown[]) => {
    record(args[0])
    return (request as (...a: unknown[]) => http.ClientRequest)(...args)
  }) as typeof mod.request
  mod.get = ((...args: unknown[]) => {
    record(args[0])
    return (get as (...a: unknown[]) => http.ClientRequest)(...args)
  }) as typeof mod.get
}

// The socket layer: everything node-compatible ends here.
const socketConnect = net.Socket.prototype.connect as (...args: unknown[]) => net.Socket
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  const first = args[0] as { host?: string; port?: number; path?: string } | number | string | undefined
  if (typeof first === "object" && first && first.path === undefined) record(first.host ?? "localhost")
  else if (typeof first === "number") record(typeof args[1] === "string" ? args[1] : "localhost")
  return socketConnect.apply(this, args)
} as typeof net.Socket.prototype.connect

const tlsConnect = tls.connect as (...args: unknown[]) => tls.TLSSocket
tls.connect = ((...args: unknown[]) => {
  const first = args[0] as { host?: string; servername?: string } | number
  record(
    typeof first === "object" ? (first.host ?? first.servername) : typeof args[1] === "string" ? args[1] : "localhost",
  )
  return tlsConnect(...args)
}) as typeof tls.connect

// The `ws` package is a binding to the native WebSocket that modules captured when
// they were first imported, so it is replaced for every importer.
const recordingWs = new Proxy(WsPackage, {
  construct(target, args) {
    record(args[0])
    return Reflect.construct(target, args)
  },
})
mock.module("ws", () => ({ ...WsPackage, default: recordingWs, WebSocket: recordingWs }))
