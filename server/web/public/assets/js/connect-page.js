import { loadWebConfig } from "./config.js";
import { copyText, externalLink, h } from "./dom.js";
import { applyTranslations, initI18n, onLangChange, t } from "./i18n.js";
import { mountLayout } from "./layout.js";

initI18n();
const config = await loadWebConfig();
mountLayout(config, "connect");

const base = location.origin;
const repo = config.repoUrl.replace(/\/+$/, "").replace(/\.git$/, "");
const repoName = repo.split("/").pop() ?? "Trafficnetwork";
const doc = (path) => `${repo}/blob/main/${path}`;

/** A copyable command block. */
function codeBlock(text) {
  const button = h("button", { type: "button", class: "small" }, t("connect.copy"));
  button.addEventListener("click", async () => {
    if (await copyText(text)) {
      button.textContent = t("connect.copied");
      window.setTimeout(() => {
        button.textContent = t("connect.copy");
      }, 1800);
    }
  });
  return h("pre", { class: "code" }, h("code", null, text), button);
}

const CURL_NO_AUTH = [`curl ${base}/v1/health`, `curl ${base}/v1/network/node-info`, `curl ${base}/v1/network/directory`].join("\n");

const CURL_AUTH = [
  "# 1. exchange your credentials for a token (needs jq; otherwise read accessToken from the JSON)",
  `TOKEN=$(curl -s -X POST ${base}/v1/auth/token \\`,
  "  -H 'content-type: application/json' \\",
  `  -d '{"clientId":"<client-id>","clientSecret":"<client-secret>"}' | jq -r .accessToken)`,
  "",
  "# 2. speed limit at a point",
  `curl -s "${base}/v1/speed-limit?lat=48.1374&lng=11.5755" \\`,
  '  -H "Authorization: Bearer $TOKEN"',
  "",
  "# 3. active reports within 2 km",
  `curl -s "${base}/v1/hazard-reports/nearby?lat=48.1374&lng=11.5755&radiusM=2000" \\`,
  '  -H "Authorization: Bearer $TOKEN"',
].join("\n");

const NODE_STEPS = [`git clone ${repo}.git`, `cd ${repoName}/server`, "cp .env.example .env   # set POSTGRES_PASSWORD and JWT_SECRET", "docker compose up -d", `curl http://localhost:3000/v1/health   # {"status":"ok","database":"ok"}`].join("\n");

const status = h("div", null, h("p", { class: "hint" }, t("connect.status.loading")));

function render() {
  const content = document.getElementById("connect-content");
  content.replaceChildren(
    h(
      "div",
      { class: "grid-3" },
      h("section", { class: "card" }, h("h2", null, t("connect.app.title")), h("p", null, t("connect.app.body1")), h("p", null, t("connect.app.body2")), h("p", null, t("connect.app.body3")), h("p", null, externalLink(`${repo}/blob/main/client-lib/README.md`, t("connect.app.link")))),
      h(
        "section",
        { class: "card" },
        h("h2", null, t("connect.node.title")),
        h("p", null, t("connect.node.body")),
        codeBlock(NODE_STEPS),
        h("p", null, t("connect.node.more")),
        h("p", null, externalLink(doc("server/docs/installation.md"), t("connect.node.link.install")), " · ", externalLink(doc("server/docs/operating.md"), t("connect.node.link.operating")), " · ", externalLink(doc("server/docs/federation-protocol.md"), t("connect.node.link.federation"))),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", null, t("connect.api.title")),
        h("p", null, t("connect.api.body1"), " ", h("code", null, base)),
        h("p", null, t("connect.api.body2")),
        h("h3", null, t("connect.api.noauth")),
        codeBlock(CURL_NO_AUTH),
        h("h3", null, t("connect.api.auth")),
        codeBlock(CURL_AUTH),
        h("p", { class: "hint" }, t("connect.api.limits")),
        h("p", null, externalLink(doc("server/docs/api.md"), t("connect.api.link"))),
      ),
    ),
    h("section", { class: "card" }, h("h2", null, t("connect.status.title")), status),
  );
  applyTranslations(document);
}

let statusData = null;

function renderStatus() {
  if (!statusData) return;
  if (statusData.error) {
    status.replaceChildren(h("p", { class: "hint" }, t("connect.status.error")));
    return;
  }
  const { info, directory } = statusData;
  const peers = directory.peers ?? [];
  status.replaceChildren(
    h(
      "dl",
      { class: "facts" },
      h("dt", null, t("connect.status.nodeId")),
      h("dd", null, h("code", null, info.nodeId)),
      h("dt", null, t("connect.status.version")),
      h("dd", null, config.version),
      h("dt", null, t("connect.status.federation")),
      h("dd", null, h("span", { class: `pill ${info.federationEnabled ? "ok" : "off"}` }, info.federationEnabled ? t("connect.status.federation.on") : t("connect.status.federation.off"))),
      h("dt", null, t("connect.status.peers")),
      h("dd", null, String(peers.length), peers.length > 0 ? h("ul", null, peers.map((peer) => h("li", null, h("code", null, peer.address), ` (${peer.tier})`))) : null),
    ),
  );
}

onLangChange(() => {
  render();
  renderStatus();
});

try {
  const [info, directory] = await Promise.all([fetch("/v1/network/node-info").then((r) => r.json()), fetch("/v1/network/directory").then((r) => r.json())]);
  statusData = { info, directory };
} catch {
  statusData = { error: true };
}
renderStatus();
