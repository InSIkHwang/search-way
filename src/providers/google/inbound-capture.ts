export interface GoogleInboundLegCapture {
  departureTime?: string;
  arrivalTime?: string;
}

const INBOUND_LEG_ID = "google-inbound-leg";

export function injectGoogleInboundLeg(
  html: string,
  leg: GoogleInboundLegCapture,
): string {
  const payload = JSON.stringify(leg);
  const block = `<pre id="${INBOUND_LEG_ID}">${payload}</pre>`;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${block}</body>`);
  }
  return `${html}${block}`;
}

export function extractGoogleInboundLegCapture(
  html: string,
): GoogleInboundLegCapture | null {
  const match = html.match(
    new RegExp(`<pre\\s+id=["']${INBOUND_LEG_ID}["'][^>]*>([\\s\\S]*?)<\\/pre>`, "i"),
  );
  if (match === null || match[1] === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1].trim()) as GoogleInboundLegCapture;
    if (parsed === null || typeof parsed !== "object") {
      return null;
    }
    return {
      ...(typeof parsed.departureTime === "string"
        ? { departureTime: parsed.departureTime }
        : {}),
      ...(typeof parsed.arrivalTime === "string"
        ? { arrivalTime: parsed.arrivalTime }
        : {}),
    };
  } catch {
    return null;
  }
}
