/**
 * The `_meta` ChatGPT sends on a tool call, one per client measured in prod
 * on 2026-09-15 (baton-internal
 * `docs/mockups/HANDOFF-client-labels-2026-09-15.md`, "What the wire says").
 *
 * The user agents are the prod values and the key set is the one captured
 * on the Mac browser event. The coordinates are NOT prod values: they are the
 * Ferry Building in San Francisco, at the two precisions prod showed (5
 * decimals from the browser, 14 from the iPhone). The three `v1/`
 * identifiers are placeholders of the same shape: the prod ones name a
 * ChatGPT account. The iPhone sample's city, region, country and timezone
 * repeat the Mac one's.
 *
 * Shared by `metaCoordinates.test.ts` and the withBaton runtime_meta tests.
 */

export const CHATGPT_MAC_BROWSER_META = {
  timezone: "America/Los_Angeles",
  "openai/locale": "en-US",
  "openai/session": "v1/placeholderSessionAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "openai/subject": "v1/placeholderSubjectAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "openai/userAgent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  "openai/organization": "v1/placeholderOrganizationAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "openai/userLocation": {
    city: "San Carlos",
    region: "California",
    country: "US",
    latitude: "37.79535",
    timezone: "America/Los_Angeles",
    longitude: "-122.39366",
  },
};

export const CHATGPT_IPHONE_META = {
  timezone: "America/Los_Angeles",
  "openai/locale": "en-US",
  "openai/session": "v1/placeholderSessionBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "openai/subject": "v1/placeholderSubjectBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "openai/userAgent": "ChatGPT/1.2026.244 (iOS 26.6.2; iPhone18,2; build 33940143573)",
  "openai/organization": "v1/placeholderOrganizationBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  "openai/userLocation": {
    city: "San Carlos",
    region: "California",
    country: "US",
    latitude: "37.79535123456789",
    timezone: "America/Los_Angeles",
    longitude: "-122.39366123456789",
  },
};
