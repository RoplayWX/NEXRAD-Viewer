// netlify/edge-functions/nexrad-proxy.js
//
// Streams requests through to nomads.ncep.noaa.gov.
//
// WHY THIS HAS TO BE AN EDGE FUNCTION AND NOT A REGULAR REDIRECT/FUNCTION:
// Netlify's normal serverless functions (and proxy redirects, which run
// through the same AWS Lambda layer) buffer the response and are capped at
// 6 MB (buffered) / 20 MB (streamed). NEXRAD Level II volume files are
// commonly 5-20+ MB, so those get silently truncated mid-download - the
// browser sees a valid 200 response, then the body read fails partway
// through with a generic "Failed to fetch" once the connection drops.
//
// Edge Functions run on Deno at the network edge and are NOT subject to
// that Lambda payload limit - `resp.body` below is piped straight through
// as a raw stream, so file size is a non-issue.

export default async (request, context) => {
  const url = new URL(request.url);

  // Anything after /api/nomads/ gets forwarded verbatim to NOAA, e.g.
  // /api/nomads/pub/data/nccf/radar/nexrad_level2/KTBW/KTBW_2026...bz2
  // -> https://nomads.ncep.noaa.gov/pub/data/nccf/radar/nexrad_level2/KTBW/...
  const upstreamPath = url.pathname.replace(/^\/api\/nomads/, '');
  const upstreamUrl = `https://nomads.ncep.noaa.gov${upstreamPath}${url.search}`;

  let upstreamResp;
  try {
    upstreamResp = await fetch(upstreamUrl, {
      headers: {
        // Some NOAA endpoints reject requests with no UA at all.
        'User-Agent': 'nexrad-level2-viewer/1.0 (+netlify-edge-function)',
      },
      redirect: 'follow',
    });
  } catch (err) {
    return new Response(`Upstream fetch to NOAA failed: ${err.message}`, {
      status: 502,
      headers: { 'content-type': 'text/plain' },
    });
  }

  // Pass through only the headers the client actually needs. Deliberately
  // NOT forwarding content-length blindly in a way that could desync from
  // the streamed body - letting the runtime chunk it is safer and avoids
  // the exact "content-length mismatch" failure mode this proxy exists to
  // fix in the first place.
  const headers = new Headers();
  const contentType = upstreamResp.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-store');
  headers.set('access-control-allow-origin', '*');

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers,
  });
};

export const config = {
  path: '/api/nomads/*',
};
