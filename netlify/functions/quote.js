// Dot Sign - quote form handler
// Runs server-side on Netlify. Receives a lead from the website quote form and:
//   1. sends a WhatsApp notification to the sales number
//   2. creates a card in the DSS Job Pipeline (Asana)
// The customer-facing email still goes out via FormSubmit from the browser,
// so this function failing never costs you the lead.
//
// Required environment variables (set in Netlify -> Site settings -> Environment):
//   WHATSAPP_PROVIDER   "callmebot" (free, simplest) or "cloud" (Meta official)
//   SALES_WHATSAPP      destination number, digits only, e.g. 61422575840
//
//   If WHATSAPP_PROVIDER=callmebot:
//     CALLMEBOT_APIKEY  key from https://www.callmebot.com/blog/free-api-whatsapp-messages/
//
//   If WHATSAPP_PROVIDER=cloud:
//     WA_TOKEN          Meta permanent access token
//     WA_PHONE_ID       WhatsApp Business phone number ID
//     WA_TEMPLATE       approved template name (business-initiated messages need one)
//
//   ASANA_TOKEN         Asana personal access token
//   ASANA_PROJECT       1217085654140870   (DSS Job Pipeline)
//   ASANA_SECTION       1217085705748844   (1. Lead Gen & Marketing)

const ASANA_PROJECT_DEFAULT = "1217085654140870";
const ASANA_SECTION_DEFAULT = "1217085705748844";

function clean(v) {
  return (v === undefined || v === null) ? "" : String(v).trim();
}

function buildSummary(d) {
  const rows = [
    ["Name", d.name],
    ["Business", d.business],
    ["Email", d.email],
    ["Phone", d.phone],
    ["Product", d.product],
    ["Category", d.category],
    ["Purpose", d.purpose],
    ["Suburb", d.suburb],
    ["Found us", d.found],
    ["Source tag", d.leadSource],
  ].filter(function (r) { return clean(r[1]); });

  let out = rows.map(function (r) { return r[0] + ": " + clean(r[1]); }).join("\n");
  if (clean(d.details)) out += "\n\nAbout the space:\n" + clean(d.details);
  return out;
}

async function sendWhatsApp(d) {
  const to = clean(process.env.SALES_WHATSAPP);
  if (!to) return { ok: false, skipped: "SALES_WHATSAPP not set" };

  const who = clean(d.business) || clean(d.name) || "Website enquiry";
  const text =
    "NEW DOT SIGN LEAD\n" + who +
    (clean(d.suburb) ? " - " + clean(d.suburb) : "") +
    "\n\n" + buildSummary(d);

  const provider = (process.env.WHATSAPP_PROVIDER || "callmebot").toLowerCase();

  if (provider === "callmebot") {
    const key = clean(process.env.CALLMEBOT_APIKEY);
    if (!key) return { ok: false, skipped: "CALLMEBOT_APIKEY not set" };
    const url = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(to) +
                "&text=" + encodeURIComponent(text) +
                "&apikey=" + encodeURIComponent(key);
    const r = await fetch(url);
    return { ok: r.ok, status: r.status };
  }

  // Meta WhatsApp Cloud API. Business-initiated messages require an approved
  // template, so the lead detail is passed as a single body parameter.
  const token = clean(process.env.WA_TOKEN);
  const phoneId = clean(process.env.WA_PHONE_ID);
  const template = clean(process.env.WA_TEMPLATE);
  if (!token || !phoneId || !template) {
    return { ok: false, skipped: "WA_TOKEN / WA_PHONE_ID / WA_TEMPLATE not set" };
  }

  const r = await fetch("https://graph.facebook.com/v20.0/" + phoneId + "/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "template",
      template: {
        name: template,
        language: { code: "en" },
        components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 1000) }] }],
      },
    }),
  });
  return { ok: r.ok, status: r.status, body: r.ok ? null : await r.text() };
}

async function createAsanaTask(d) {
  const token = clean(process.env.ASANA_TOKEN);
  if (!token) return { ok: false, skipped: "ASANA_TOKEN not set" };

  const project = clean(process.env.ASANA_PROJECT) || ASANA_PROJECT_DEFAULT;
  const section = clean(process.env.ASANA_SECTION) || ASANA_SECTION_DEFAULT;

  const who = clean(d.business) || clean(d.name) || "Website enquiry";
  const title = "Lead - " + who + (clean(d.suburb) ? " - " + clean(d.suburb) : "");

  const notes =
    "Website quote request from dotsign.com.au\n\n" +
    buildSummary(d) +
    "\n\nNext actions (Sales & Quoting):\n" +
    "1. Confirm size + indoor/outdoor, check council permit if exterior\n" +
    "2. Price against current supplier tiers\n" +
    "3. Send quote (target: within 1 business day)\n" +
    "4. Log in Lead & Deal Tracker with vertical + source tag";

  const create = await fetch("https://app.asana.com/api/1.0/tasks", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { name: title, notes: notes, projects: [project] } }),
  });

  if (!create.ok) return { ok: false, status: create.status, body: await create.text() };

  const created = await create.json();
  const taskId = created && created.data && created.data.gid;

  // Move into the Lead Gen section (task creation cannot target a section directly)
  if (taskId && section) {
    await fetch("https://app.asana.com/api/1.0/sections/" + section + "/addTask", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ data: { task: taskId } }),
    });
  }

  return { ok: true, taskId: taskId };
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let data;
  try {
    data = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  // Basic guard: ignore empty/bot submissions
  if (!clean(data.name) && !clean(data.email) && !clean(data.phone)) {
    return new Response(JSON.stringify({ ignored: true }), { status: 200 });
  }

  const results = await Promise.allSettled([sendWhatsApp(data), createAsanaTask(data)]);

  const summary = {
    whatsapp: results[0].status === "fulfilled" ? results[0].value : { ok: false, error: String(results[0].reason) },
    asana: results[1].status === "fulfilled" ? results[1].value : { ok: false, error: String(results[1].reason) },
  };

  console.log("Dot Sign lead processed:", JSON.stringify(summary));

  // Always 200 - the browser has already moved on to the email submission.
  return new Response(JSON.stringify({ ok: true, summary: summary }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
