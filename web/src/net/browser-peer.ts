import type { PeerConnectionFactory, PeerConnectionLike } from './transport.js';

/**
 * The one place where the browser's `RTCPeerConnection` is adapted to `PeerConnectionLike`.
 *
 * Why a cast rather than an adapter class: `PeerConnectionLike` declares exactly the
 * surface this project uses, and the only differences are TypeScript's opinions rather
 * than behavioural ones:
 *
 *  - the DOM declares handlers as `(this: RTCDataChannel, ev: MessageEvent) => any`;
 *    `{ data: unknown }` is a supertype of `MessageEvent`, so anything this code passes
 *    is accepted by the real object;
 *  - `createOffer()`/`createAnswer()` return `RTCSessionDescriptionInit`, which has the
 *    same `type`/`sdp` shape the transport reads.
 *
 * Keeping the cast in one named function means the rest of the codebase never casts, and
 * if a browser ever diverges from the interface, this is the single place to fix.
 */
export function browserPeerConnectionFactory(config: RTCConfiguration): PeerConnectionLike {
  if (typeof RTCPeerConnection !== 'function') {
    throw new Error('WebRTC is not available in this browser');
  }
  return new RTCPeerConnection(config) as unknown as PeerConnectionLike;
}

export const browserPeerConnection: PeerConnectionFactory = browserPeerConnectionFactory;
