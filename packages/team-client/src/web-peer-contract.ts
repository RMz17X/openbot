import type {
  RemoteHostProtocols,
  RemoteTeamCommand,
  RemoteTeamCommandResult,
  RemoteTeamPeerActions,
} from "./remote-peer";

/**
 * The peer contract that the web client needs.
 *
 * The web client talks to a host over two transports: the remote peer (WebRTC over Signal) and the
 * direct peer (plain HTTP against a local Team API). Both answer the same commands and both raise
 * the same events, so the connection layer can hold either one. The contract is the part of a peer
 * that the connection layer reads, and nothing more: the two peers keep their own transports.
 *
 * The contract is derived from the uses in `web-host-connections.ts`:
 * - `execute` runs a command and answers its result.
 * - `dispose` ends the peer.
 * - `setWaitForHost` lets a status connection become the opened host.
 */
export interface WebTeamPeer {
  execute(command: RemoteTeamCommand): Promise<RemoteTeamCommandResult>;
  dispose(): Promise<void>;
  /** Whether the peer waits for the host to come online instead of failing. */
  setWaitForHost(value: boolean): void;
  /** Streams bytes to the host, such as a file the member uploads. */
  sendHostStreamData(data: string | ArrayBuffer): Promise<void>;
  /** Cancels the upload that is in flight. */
  cancelUpload(): Promise<void>;
  /** Tells the host which agent this member is writing to. */
  setTyping(agentId: string | null, typing: boolean): void;
}

/** The actions a peer raises. The peer reads them through `current`, so a caller can swap them. */
export interface WebTeamPeerActionsRef {
  current: RemoteTeamPeerActions;
}

/** The options both peers take. */
export interface WebTeamPeerOptions {
  waitForHost?: boolean;
  hostProtocols?: RemoteHostProtocols;
}

/** Creates a peer of the contract. The direct mode passes the HTTP peer, the cloud the remote one. */
export type CreateWebTeamPeer = (actions: WebTeamPeerActionsRef, options?: WebTeamPeerOptions) => WebTeamPeer;
