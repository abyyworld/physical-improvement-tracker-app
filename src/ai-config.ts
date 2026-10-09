// Arise's private AI: an open model running in Tinfoil's secure enclaves, reached through the
// small proxy in worker/ai-proxy (which keeps the API key off phones and limits use per account).
//
// `proxy` is the Worker's address once it's deployed (see worker/ai-proxy/README.md), ending in
// /v1/. Until then it's empty, and the app offers on-device AI and people's own AI services only.
// `model` is the enclave model to ask for; if Tinfoil stops serving it, the app picks the largest
// model on the list instead.

export const PRIVATE_AI = {
  proxy: '',
  model: 'llama3-3-70b',
  name: 'Private AI',
};
