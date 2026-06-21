// src/realtime/sfu/sfu.types.ts

export type SfuTransportDir = 'send' | 'recv';

export interface SfuPeerState {
  userId: string;
  sendTransportId: string | null;
  recvTransportId: string | null;
  /** producerId → kind */
  producers: Map<string, 'audio' | 'video'>;
  /** consumerId → producerId */
  consumers: Map<string, string>;
}

export interface SfuRoomState {
  callId: string;
  /** userId → SfuPeerState */
  peers: Map<string, SfuPeerState>;
}
