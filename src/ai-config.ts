// Arise's private AI: an open model running in Tinfoil's secure enclaves, reached through the
// small proxy in worker/ai-proxy (which keeps the API key off phones and limits use per account).
//
// `proxy` is the Worker's address once it's deployed (see worker/ai-proxy/README.md), ending in
// /v1/. Until then it's empty, and the app offers on-device AI and people's own AI services only.
// `model` is the enclave model to ask for: gpt-oss-120b, cheap to run (only about 5B of its 117B
// parameters work on each token) and strong at the reasoning and structured answers the coach
// needs. If Tinfoil stops serving it, the app tries the other good, cheap ones first (see ai.js).

export const PRIVATE_AI = {
  proxy: 'https://arise-ai.abyyworld.workers.dev/v1/',
  model: 'gpt-oss-120b',
  name: 'Private AI',
};
