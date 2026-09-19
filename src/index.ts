/**
 * `@xorgate/react-native` — the React Native half of `@xorgate/react`.
 *
 * Everything that is pure or platform-neutral lives in `@xorgate/react` and is
 * re-exported here, so an app imports from ONE package: the data hooks, live
 * telemetry, the live-block policy, the replay timeline and clock, the
 * telemetry math, the types. What this package adds is the runtime underneath
 * them (`nativePlatform`, `XorgateNativeProvider`) and the pieces that cannot
 * be neutral because they are pixels: `useLiveVideo` / `LiveVideo` over
 * react-native-webrtc's `RTCView`, and `useReplayPlayer` / `ReplayVideo` over
 * expo-video.
 *
 * The browser-only exports of `@xorgate/react` — its `useLiveVideo`,
 * `LiveVideo`, `useReplayPlayer`, `ReplayVideo` and the `browser*` platform
 * helpers — are deliberately NOT re-exported: they need `HTMLVideoElement`,
 * `window` or Media Source Extensions, none of which exist here. The four
 * names are SHADOWED by the native implementations above, so an app that
 * imports from this package gets the one that works on a phone; importing
 * `@xorgate/react` directly still works and is how you reach them on web.
 */

// ---------------------------------------------------------------------------
// The React Native runtime
// ---------------------------------------------------------------------------

export { nativePlatform, type NativePlatformOptions } from "./platform.js";
export { createNativeWebRtcPlatform } from "./webrtc-platform.js";
export { appStateWake, composeWake, type WakeSource } from "./wake.js";
export {
  XorgateNativeProvider,
  type XorgateNativeProviderProps,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Live video (RTCView)
// ---------------------------------------------------------------------------

export {
  useLiveVideo,
  type UseLiveVideo,
  type UseLiveVideoOptions,
} from "./use-live-video.js";
export { LiveVideo, type LiveVideoProps } from "./live-video.js";

// ---------------------------------------------------------------------------
// Replay (expo-video)
// ---------------------------------------------------------------------------

export {
  ExpoVideoReplayEngine,
  type ExpoVideoReplayEngineOptions,
} from "./replay-engine.js";
export {
  useReplayPlayer,
  type UseReplayPlayer,
  type UseReplayPlayerNativeOptions,
  type ReplayLaneMedia,
  type ReplayLaneState,
  type ReplayLaneStatus,
  type UseReplayPlayerOptions,
} from "./use-replay-player.js";
export { ReplayVideo, type ReplayVideoProps } from "./replay-video.js";

// ---------------------------------------------------------------------------
// Re-exported unchanged from `@xorgate/react`
// ---------------------------------------------------------------------------

export {
  // Provider and tenancy
  XorgateProvider,
  useXorgate,
  useXorgateTenancy,
  DEFAULT_BASE_URL,
  type XorgateProviderProps,
  type XorgateConfig,
  type XorgateAuth,
  type FirstPartyAuth,
  type SessionTokenAuth,
  type ApiKeyAuth,
  type LiveCredentialsAuth,
  type LiveCredentials,
  type LiveUnavailableReason,
  type Awaitable,
  type XorgatePlatform,

  // Errors and the backend vocabulary
  XorgateError,
  isXorgateError,
  type AcceptedTransferOffer,
  type BulkTransferItem,
  type CreatedTransferOffer,
  type Device,
  type DeviceModel,
  type LatestByMetric,
  type LatestReading,
  type MediaSession,
  type Me,
  type MetricName,
  type Organization,
  type PageMeta,
  type RecordingRun,
  type ReplayGap,
  type ReplayManifest,
  type ReplaySegment,
  type ReplaySession,
  type StreamKey,
  type TelemetryHistory,
  type TelemetryReading,
  type TransferAdoption,
  type TransferBlocker,
  type TransferBlockerCode,
  type TransferDeviceInput,
  type TransferOffer,
  type TransferOfferPreview,
  type TransferOfferStatus,
  type TransferPreview,
  type TransferResult,
  type TransferSummary,
  type TransferTenancy,
  type ScopeAttributeResult,
  type VideoChannel,
  type Workspace,
  type XorgateClient,

  // Data hooks
  useMe,
  useOrganizations,
  useWorkspaces,
  useDevices,
  useDevice,
  useDeviceModel,
  useTelemetryLatest,
  useTelemetryHistory,
  useVideoChannels,
  useRecordingRuns,
  useSessions,
  type QueryResult,
  type QueryOptions,
  type UseDevicesParams,
  type UseDevicesResult,
  type UseTelemetryHistoryParams,
  type UseSessionsParams,
  type UseRunsResult,
  type UseSessionsResult,

  // Live telemetry and the live plane
  useLiveTelemetry,
  useLivePlane,
  useLiveCredentials,
  // Live SCOPE: a device can be transferred to another workspace or
  // organization while a viewer is open, and a vended credential is cached for
  // up to ~50 minutes. On a phone that window is longer in practice, because a
  // backgrounded app resumes onto the same cached credential. Neither plane
  // fails loudly: telemetry simply stops arriving and video keeps flowing until
  // the next reconnect. `useDeviceScope` is how that becomes a typed error.
  useLiveScope,
  useDeviceScope,
  type UseLiveScope,
  type UseDeviceScope,
  type UseDeviceScopeOptions,
  type DeviceScopeStatus,
  type LiveScope,
  parseTelemetryPayload,
  presignIotWssUrl,
  type UseLiveTelemetry,
  type UseLiveTelemetryOptions,
  type LiveStatus,
  type TelemetryPoint,
  type TelemetrySnapshot,
  type TelemetryFeedDeps,
  type MqttLikeClient,
  type MqttConnectionSpec,
  type ResolvedLiveCredentials,
  type ParsedTelemetryPayload,
  type TelemetryRecordingStatus,
  type TelemetryMediaStatus,
  type TelemetryStreamStatus,
  type LiveBlockPayload,

  // Live-block policy
  useLiveBlock,
  resolveLiveBlock,
  liveBlockElapsedMs,
  LIVE_BLOCK_STALE_MS,
  type LiveBlockReason,
  type LiveBlockOpenReason,
  type LiveBlockState,
  type ResolveLiveBlockInput,

  // The video session core and its platform boundary
  useLiveVideoSession,
  type UseLiveVideoSession,
  type UseLiveVideoSessionOptions,
  type LiveVideoStatus,
  type LiveVideoStats,
  type WebRtcPlatform,
  type PeerConnectionLike,
  type SignalingLike,
  type TimerHost,

  // Replay: pure timeline, lanes, clock and telemetry math (the engine is N3)
  useReplayManifest,
  useReplayPlayerCore,
  useReplayTelemetry,
  buildTimeline,
  segmentEnd,
  segmentAt,
  hasCoverageAt,
  gapAt,
  nextSegmentAfter,
  prevBoundary,
  nextBoundary,
  clampTs,
  buildLanes,
  buildClockTimeline,
  segmentUrlKey,
  ReplayClock,
  REPLAY_RATES,
  parseSegmentMediaInfo,
  seriesFromReadings,
  floorIndex,
  latestWithin,
  metricGroup,
  stalenessMs,
  overviewStalenessMs,
  chooseIntervalSeconds,
  windowBoundsFor,
  windowNeedsRefetch,
  buildTrace,
  traceLines,
  traveledLines,
  positionAt,
  GROUP_STALENESS_MS,
  DEFAULT_STALENESS_MS,
  WINDOW_SPAN_MS,
  WINDOW_MIN_SPAN_MS,
  type UseReplayManifestParams,
  type UseReplayManifestResult,
  type UseReplayPlayerCore,
  type UseReplayTelemetry,
  type UseReplayTelemetryOptions,
  type ReplayEngine,
  type ReplayEngineOptions,
  type ReplayEngineFactory,
  type ReplayTimeline,
  type ReplayLane,
  type LaneSegment,
  type ReplayClockState,
  type ReplayRate,
  type PacerCandidate,
  type GapSkipEvent,
  type SegmentMediaInfo,
  type MetricSeries,
  type GpsTrace,
  type WindowBounds,
  type PositionResolution,
} from "@xorgate/react";
