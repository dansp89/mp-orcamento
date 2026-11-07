import { swagger } from "@elysiajs/swagger";
import { Elysia, t } from "elysia";

function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const normalized = String(value)
    .trim()
    .replace(/\s+/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function estimateAWS(lojas: unknown, instancias: unknown) {
  const totalLojas = toNumber(lojas);
  const totalInstancias = Math.max(1, Math.floor(toNumber(instancias) || 1));

  if (totalLojas <= 5000) {
    return {
      min: 750 + totalInstancias * 250,
      max: 950 + totalInstancias * 350,
      label: "Infra mínima",
    };
  }

  if (totalLojas <= 40000) {
    return {
      min: 4000 + totalInstancias * 1000,
      max: 9500 + totalInstancias * 2500,
      label: "Infra média",
    };
  }

  return {
    min: 18000 + totalInstancias * 4000,
    max: 54000 + totalInstancias * 12000,
    label: "Infra alta",
  };
}

const port = Number(process.env.PORT || 9876);
const HOURS_PER_MONTH = 730;
const AWS_PRICING_PUBLIC_BASE = "https://pricing.us-east-1.amazonaws.com";
const AWS_PRICE_CACHE_TTL_MS = Math.max(60_000, Number(process.env.AWS_PRICE_CACHE_TTL_MS || 21_600_000));
const HCLOUD_API_BASE = "https://api.hetzner.cloud/v1";
const HCLOUD_CACHE_TTL_MS = Math.max(60_000, Number(process.env.HCLOUD_CACHE_TTL_MS || 3_600_000));
const HADCLOUD_PLANS_URL = "https://hadcloud.com.br/cloud-server/";
const HADCLOUD_SHARED_PLANS_URL = "https://hadcloud.com.br/hospedagem-de-sites/";
const HADCLOUD_CACHE_TTL_MS = Math.max(60_000, Number(process.env.HADCLOUD_CACHE_TTL_MS || 3_600_000));
const REGION_ENUM = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
] as const;
const HCLOUD_LOCATION_ENUM = ["fsn1", "nbg1", "hel1", "ash", "hil", "sin"] as const;
const HCLOUD_BILLING_ENUM = ["hourly", "monthly"] as const;
const HADCLOUD_PLAN_ENUM = [
  "HN1-1-10",
  "HN1-2-10",
  "HS2-4-40",
  "HM4-8-40",
  "HM8-16-20",
  "HH16-9-100",
] as const;
const HADCLOUD_SHARED_PLAN_ENUM = [
  "Had Basico",
  "Had Plus",
  "Had Max",
  "Had Ultra",
  "Had Elite",
  "Had Rocket",
] as const;
const EC2_PRESET_ENUM = [
  "t4g.medium",
  "t4g.large",
  "t4g.xlarge",
  "t4g.2xlarge",
  "t3.medium",
  "t3.large",
  "t3.xlarge",
  "m6i.large",
  "m6i.xlarge",
  "c7g.large",
] as const;
const RDS_PRESET_ENUM = [
  "db.t4g.medium",
  "db.t4g.large",
  "db.t4g.xlarge",
  "db.t4g.2xlarge",
  "db.t3.medium",
  "db.t3.large",
  "db.m6i.large",
  "db.m6i.xlarge",
] as const;

type AwsProduct = {
  sku: string;
  attributes: Record<string, string>;
};

type AwsRegionPriceDoc = {
  offerCode?: string;
  version?: string;
  publicationDate?: string;
  products?: Record<string, AwsProduct>;
  terms?: {
    OnDemand?: Record<
      string,
      Record<
        string,
        {
          priceDimensions?: Record<
            string,
            {
              pricePerUnit?: { USD?: string };
            }
          >;
        }
      >
    >;
  };
};

const awsPriceCache = new Map<
  string,
  {
    expiresAt: number;
    url: string;
    doc: AwsRegionPriceDoc;
  }
>();

const awsMetaCache = new Map<string, { expiresAt: number; data: unknown }>();
const hcloudCache = new Map<string, { expiresAt: number; data: unknown }>();
const hadcloudCache = new Map<string, { expiresAt: number; data: unknown }>();

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao baixar ${url}: HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function loadAwsOffersIndex() {
  const cacheKey = "offers-index";
  const now = Date.now();
  const cached = awsMetaCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data as {
      publicationDate?: string;
      offers?: Record<string, { offerCode?: string; currentRegionIndexUrl?: string; currentVersionUrl?: string }>;
    };
  }

  const data = await fetchJson<{
    publicationDate?: string;
    offers?: Record<string, { offerCode?: string; currentRegionIndexUrl?: string; currentVersionUrl?: string }>;
  }>(`${AWS_PRICING_PUBLIC_BASE}/offers/v1.0/aws/index.json`);
  awsMetaCache.set(cacheKey, { expiresAt: now + AWS_PRICE_CACHE_TTL_MS, data });
  return data;
}

async function loadAwsServiceRegionIndex(serviceCode: string) {
  const cacheKey = `region-index:${serviceCode}`;
  const now = Date.now();
  const cached = awsMetaCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data as {
      publicationDate?: string;
      regions?: Record<string, { regionCode?: string; currentVersionUrl?: string }>;
    };
  }

  const data = await fetchJson<{
    publicationDate?: string;
    regions?: Record<string, { regionCode?: string; currentVersionUrl?: string }>;
  }>(`${AWS_PRICING_PUBLIC_BASE}/offers/v1.0/aws/${serviceCode}/current/region_index.json`);
  awsMetaCache.set(cacheKey, { expiresAt: now + AWS_PRICE_CACHE_TTL_MS, data });
  return data;
}

async function loadAwsRegionPriceDoc(serviceCode: string, regionCode: string) {
  const cacheKey = `${serviceCode}:${regionCode}`;
  const now = Date.now();
  const cached = awsPriceCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached;

  const regionIndex = await loadAwsServiceRegionIndex(serviceCode);

  const currentVersionUrl = regionIndex.regions?.[regionCode]?.currentVersionUrl;
  if (!currentVersionUrl) {
    throw new Error(`Região ${regionCode} não encontrada na Price List pública para ${serviceCode}.`);
  }

  const serviceRegionDocUrl = `${AWS_PRICING_PUBLIC_BASE}${currentVersionUrl}`;
  const doc = await fetchJson<AwsRegionPriceDoc>(serviceRegionDocUrl);
  const entry = {
    expiresAt: now + AWS_PRICE_CACHE_TTL_MS,
    url: serviceRegionDocUrl,
    doc,
  };
  awsPriceCache.set(cacheKey, entry);
  return entry;
}

function extractUsdFromOnDemand(skuTerms: Record<string, { priceDimensions?: Record<string, { pricePerUnit?: { USD?: string } }> }> | undefined) {
  if (!skuTerms) return 0;
  for (const term of Object.values(skuTerms)) {
    const dimensions = term.priceDimensions || {};
    for (const dim of Object.values(dimensions)) {
      const usd = Number(dim.pricePerUnit?.USD || 0);
      if (Number.isFinite(usd) && usd > 0) return usd;
    }
  }
  return 0;
}

function findOnDemandHourlyUsd(
  doc: AwsRegionPriceDoc,
  predicate: (attrs: Record<string, string>) => boolean,
) {
  const products = doc.products || {};
  const onDemand = doc.terms?.OnDemand || {};
  for (const product of Object.values(products)) {
    const attrs = product.attributes || {};
    if (!predicate(attrs)) continue;
    const usd = extractUsdFromOnDemand(onDemand[product.sku]);
    if (usd > 0) {
      return {
        sku: product.sku,
        hourlyUsd: usd,
        attributes: attrs,
      };
    }
  }
  return null;
}

function findProductsByFilters(
  doc: AwsRegionPriceDoc,
  filters: Record<string, string>,
  limit = 20,
) {
  const products = doc.products || {};
  const onDemand = doc.terms?.OnDemand || {};
  const out: Array<{
    sku: string;
    attributes: Record<string, string>;
    priceDimensions: Array<{ rateUsd: number; unit: string; description: string }>;
  }> = [];

  for (const product of Object.values(products)) {
    const attrs = product.attributes || {};
    let ok = true;
    for (const [k, v] of Object.entries(filters)) {
      if (!v) continue;
      if ((attrs[k] || "") !== v) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const skuTerms = onDemand[product.sku] || {};
    const priceDimensions: Array<{ rateUsd: number; unit: string; description: string }> = [];
    for (const term of Object.values(skuTerms)) {
      const dims = term.priceDimensions || {};
      for (const dim of Object.values(dims)) {
        const rateUsd = Number(dim.pricePerUnit?.USD || 0);
        if (rateUsd >= 0) {
          priceDimensions.push({
            rateUsd,
            unit: (dim as { unit?: string }).unit || "Unknown",
            description: (dim as { description?: string }).description || "",
          });
        }
      }
    }

    out.push({
      sku: product.sku,
      attributes: attrs,
      priceDimensions,
    });
    if (out.length >= limit) break;
  }

  return out;
}

async function fetchUsdBrlRateOnline() {
  const response = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL");
  if (!response.ok) {
    throw new Error(`Falha ao consultar câmbio online: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    USDBRL?: {
      bid?: string;
      ask?: string;
      create_date?: string;
    };
  };

  const bid = Number(data?.USDBRL?.bid || 0);
  if (!Number.isFinite(bid) || bid <= 0) {
    throw new Error("Falha ao interpretar cotação USD/BRL da API online.");
  }

  return {
    usdToBrl: bid,
    bid,
    ask: Number(data?.USDBRL?.ask || 0),
    createDate: data?.USDBRL?.create_date || null,
    source: "https://economia.awesomeapi.com.br/json/last/USD-BRL",
  };
}

async function fetchEurBrlRateOnline() {
  const response = await fetch("https://economia.awesomeapi.com.br/json/last/EUR-BRL");
  if (!response.ok) {
    throw new Error(`Falha ao consultar câmbio EUR/BRL online: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    EURBRL?: {
      bid?: string;
      ask?: string;
      create_date?: string;
    };
  };

  const bid = Number(data?.EURBRL?.bid || 0);
  if (!Number.isFinite(bid) || bid <= 0) {
    throw new Error("Falha ao interpretar cotação EUR/BRL da API online.");
  }

  return {
    eurToBrl: bid,
    bid,
    ask: Number(data?.EURBRL?.ask || 0),
    createDate: data?.EURBRL?.create_date || null,
    source: "https://economia.awesomeapi.com.br/json/last/EUR-BRL",
  };
}

function resolveHcloudToken(headers: Record<string, string | undefined>) {
  return (
    headers["x-hcloud-token"] ||
    headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    process.env.HCLOUD_TOKEN ||
    ""
  ).trim();
}

async function fetchHcloudJson<T>(path: string, token: string): Promise<T> {
  if (!token) {
    throw new Error("Token hcloud ausente. Envie em x-hcloud-token ou configure HCLOUD_TOKEN.");
  }

  const response = await fetch(`${HCLOUD_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Falha na API hcloud (${path}): HTTP ${response.status} - ${text.slice(0, 240)}`);
  }

  return (await response.json()) as T;
}

type HcloudPrice = {
  location: string;
  price_hourly?: { net?: string; gross?: string };
  price_monthly?: { net?: string; gross?: string };
};

type HcloudServerType = {
  id: number;
  name: string;
  description?: string;
  cpu_type?: string;
  architecture?: string;
  cores?: number;
  memory?: number;
  disk?: number;
  prices?: HcloudPrice[];
};

type HcloudLoadBalancerType = {
  id: number;
  name: string;
  description?: string;
  max_connections?: number;
  max_services?: number;
  max_targets?: number;
  prices?: HcloudPrice[];
};

async function loadHcloudServerTypes(token: string) {
  const cacheKey = `hcloud:server_types:${token.slice(0, 8)}`;
  const now = Date.now();
  const cached = hcloudCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data as HcloudServerType[];

  const data = await fetchHcloudJson<{ server_types?: HcloudServerType[] }>("/server_types?per_page=200", token);
  const out = data.server_types || [];
  hcloudCache.set(cacheKey, { expiresAt: now + HCLOUD_CACHE_TTL_MS, data: out });
  return out;
}

async function loadHcloudLoadBalancerTypes(token: string) {
  const cacheKey = `hcloud:load_balancer_types:${token.slice(0, 8)}`;
  const now = Date.now();
  const cached = hcloudCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.data as HcloudLoadBalancerType[];

  const data = await fetchHcloudJson<{ load_balancer_types?: HcloudLoadBalancerType[] }>("/load_balancer_types?per_page=200", token);
  const out = data.load_balancer_types || [];
  hcloudCache.set(cacheKey, { expiresAt: now + HCLOUD_CACHE_TTL_MS, data: out });
  return out;
}

function getHcloudRateEur(
  prices: HcloudPrice[] | undefined,
  location: string | undefined,
  billing: "hourly" | "monthly",
) {
  const list = prices || [];
  const byLocation = location ? list.find((p) => p.location === location) : list[0];
  if (!byLocation) return 0;
  const value = billing === "hourly" ? byLocation.price_hourly?.net : byLocation.price_monthly?.net;
  const eur = Number(value || 0);
  return Number.isFinite(eur) ? eur : 0;
}

type HadCloudPlan = {
  planCode: string;
  monthlyBrl: number;
  cpu: number | null;
  ramGb: number | null;
  storageGb: number | null;
  rawFeatures: string[];
};

type HadCloudSharedPlan = {
  planName: string;
  monthlyBrl: number;
  rawFeatures: string[];
  storageGb: number | null;
};

function extractNumber(pattern: RegExp, value: string) {
  const match = value.match(pattern);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseHadCloudPlansFromHtml(html: string) {
  const plans: HadCloudPlan[] = [];
  const seen = new Set<string>();
  const regex = /<h3[^>]*class="elementor-image-box-title">([^<]+)<\/h3>[\s\S]{0,1600}?<span class="preco">R\$([\d.,]+)<span class="mes">\/mes<\/span><\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const planCode = (match[1] || "").trim();
    if (!planCode || seen.has(planCode)) continue;
    seen.add(planCode);

    const monthlyBrl = toNumber((match[2] || "").trim());
    const chunk = html.slice(match.index, match.index + 5000);
    const features = [...chunk.matchAll(/<span class="elementor-icon-list-text">([^<]+)<\/span>/g)]
      .map((m) => (m[1] || "").trim())
      .filter(Boolean);

    const cpuFeature = features.find((f) => /CPU/i.test(f)) || "";
    const ramFeature = features.find((f) => /RAM/i.test(f)) || "";
    const storageFeature = features.find((f) => /SSD|NVME|armazenamento/i.test(f) && /GB/i.test(f)) || "";

    plans.push({
      planCode,
      monthlyBrl,
      cpu: extractNumber(/(\d+)\s*CPU/i, cpuFeature),
      ramGb: extractNumber(/(\d+)\s*GB/i, ramFeature),
      storageGb: extractNumber(/(\d+)\s*GB/i, storageFeature),
      rawFeatures: features,
    });
  }

  return plans;
}

async function loadHadCloudPlans() {
  const cacheKey = "hadcloud:plans";
  const now = Date.now();
  const cached = hadcloudCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data as { source: string; fetchedAt: string; plans: HadCloudPlan[] };
  }

  const response = await fetch(HADCLOUD_PLANS_URL);
  if (!response.ok) {
    throw new Error(`Falha ao consultar HADCloud (${HADCLOUD_PLANS_URL}): HTTP ${response.status}`);
  }
  const html = await response.text();
  const plans = parseHadCloudPlansFromHtml(html);
  if (!plans.length) {
    throw new Error("Não foi possível extrair planos da página pública da HADCloud.");
  }

  const data = {
    source: HADCLOUD_PLANS_URL,
    fetchedAt: new Date().toISOString(),
    plans,
  };
  hadcloudCache.set(cacheKey, { expiresAt: now + HADCLOUD_CACHE_TTL_MS, data });
  return data;
}

function parseHadCloudSharedPlansFromHtml(html: string) {
  const plans: HadCloudSharedPlan[] = [];
  const seen = new Set<string>();
  const regex = /<h3[^>]*class="elementor-image-box-title">([^<]+)<\/h3>[\s\S]{0,2000}?<span class="preco">R\$([\d.,]+)\*?<span class="mes">\/m[eê]s<\/span>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const planName = (match[1] || "").trim();
    if (!planName || seen.has(planName)) continue;
    seen.add(planName);

    const monthlyBrl = toNumber((match[2] || "").trim());
    const chunk = html.slice(match.index, match.index + 6000);
    const features = [...chunk.matchAll(/<span class="elementor-icon-list-text">([^<]+)<\/span>/g)]
      .map((m) => (m[1] || "").trim())
      .filter(Boolean);

    const storageFeature = features.find((f) => /SSD|NVME|armazenamento/i.test(f) && /GB/i.test(f)) || "";

    plans.push({
      planName,
      monthlyBrl,
      rawFeatures: features,
      storageGb: extractNumber(/(\d+)\s*GB/i, storageFeature),
    });
  }

  return plans;
}

async function loadHadCloudSharedPlans() {
  const cacheKey = "hadcloud:shared-plans";
  const now = Date.now();
  const cached = hadcloudCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data as { source: string; fetchedAt: string; plans: HadCloudSharedPlan[] };
  }

  const response = await fetch(HADCLOUD_SHARED_PLANS_URL);
  if (!response.ok) {
    throw new Error(`Falha ao consultar HADCloud (${HADCLOUD_SHARED_PLANS_URL}): HTTP ${response.status}`);
  }
  const html = await response.text();
  const plans = parseHadCloudSharedPlansFromHtml(html);
  if (!plans.length) {
    throw new Error("Não foi possível extrair planos de hospedagem compartilhada da HADCloud.");
  }

  const data = {
    source: HADCLOUD_SHARED_PLANS_URL,
    fetchedAt: new Date().toISOString(),
    plans,
  };
  hadcloudCache.set(cacheKey, { expiresAt: now + HADCLOUD_CACHE_TTL_MS, data });
  return data;
}

async function estimateAwsPublic(input: {
  lojas: number;
  instanciasAws: number;
  regionCode: string;
  ec2InstanceType: string;
  rdsInstanceType: string;
  rdsMultiAz: boolean;
  usdToBrl: number;
}) {
  const regionCode = input.regionCode || "us-east-1";

  const [ec2Source, rdsSource] = await Promise.all([
    loadAwsRegionPriceDoc("AmazonEC2", regionCode),
    loadAwsRegionPriceDoc("AmazonRDS", regionCode),
  ]);

  const ec2Primary = findOnDemandHourlyUsd(ec2Source.doc, (attrs) => (
    attrs.regionCode === regionCode &&
    attrs.instanceType === input.ec2InstanceType &&
    attrs.operatingSystem === "Linux" &&
    attrs.preInstalledSw === "NA" &&
    attrs.tenancy === "Shared" &&
    attrs.capacitystatus === "Used" &&
    (attrs.operation || "").startsWith("RunInstances")
  ));

  const ec2Fallback = findOnDemandHourlyUsd(ec2Source.doc, (attrs) => (
    attrs.regionCode === regionCode &&
    attrs.instanceType === input.ec2InstanceType &&
    attrs.operatingSystem === "Linux" &&
    attrs.preInstalledSw === "NA" &&
    attrs.tenancy === "Shared" &&
    attrs.capacitystatus === "Used"
  ));

  const ec2Match = ec2Primary || ec2Fallback;
  if (!ec2Match) {
    throw new Error(`Preço EC2 não encontrado para ${input.ec2InstanceType} em ${regionCode} (Linux/Shared/OnDemand).`);
  }

  const rdsMatch = findOnDemandHourlyUsd(rdsSource.doc, (attrs) => (
    attrs.regionCode === regionCode &&
    attrs.instanceType === input.rdsInstanceType &&
    attrs.databaseEngine === "MySQL" &&
    attrs.deploymentOption === "Single-AZ"
  ));

  if (!rdsMatch) {
    throw new Error(`Preço RDS não encontrado para ${input.rdsInstanceType} em ${regionCode} (MySQL/Single-AZ).`);
  }

  const ec2HourlyUsd = ec2Match.hourlyUsd;
  const rdsHourlyUsdBase = rdsMatch.hourlyUsd;

  const rdsHourlyUsd = input.rdsMultiAz ? rdsHourlyUsdBase * 2 : rdsHourlyUsdBase;
  const ec2MonthlyUsd = ec2HourlyUsd * HOURS_PER_MONTH * input.instanciasAws;
  const rdsMonthlyUsd = rdsHourlyUsd * HOURS_PER_MONTH;
  const totalMonthlyUsd = ec2MonthlyUsd + rdsMonthlyUsd;
  const totalMonthlyBrl = totalMonthlyUsd * input.usdToBrl;

  return {
    source: "aws-public-price-list-bulk-api",
    assumptions: {
      hoursPerMonth: HOURS_PER_MONTH,
      regionCode,
      ec2OperatingSystem: "Linux",
      rdsEngine: "MySQL",
      rdsDeploymentOption: input.rdsMultiAz ? "Multi-AZ (estimado como 2x Single-AZ)" : "Single-AZ",
      cacheTtlMs: AWS_PRICE_CACHE_TTL_MS,
      noApiKeyRequired: true,
    },
    dataSources: {
      ec2: {
        url: ec2Source.url,
        publicationDate: ec2Source.doc.publicationDate || null,
      },
      rds: {
        url: rdsSource.url,
        publicationDate: rdsSource.doc.publicationDate || null,
      },
    },
    components: {
      ec2: {
        instanceType: input.ec2InstanceType,
        instances: input.instanciasAws,
        sku: ec2Match.sku,
        hourlyUsd: ec2HourlyUsd,
        monthlyUsd: ec2MonthlyUsd,
        monthlyBrl: ec2MonthlyUsd * input.usdToBrl,
      },
      rds: {
        instanceType: input.rdsInstanceType,
        multiAz: input.rdsMultiAz,
        skuSingleAz: rdsMatch.sku,
        hourlyUsd: rdsHourlyUsd,
        monthlyUsd: rdsMonthlyUsd,
        monthlyBrl: rdsMonthlyUsd * input.usdToBrl,
      },
    },
    total: {
      monthlyUsd: totalMonthlyUsd,
      monthlyBrl: totalMonthlyBrl,
    },
  };
}

const app = new Elysia()
  .use(
    swagger({
      documentation: {
        info: {
          title: "AWS Calculator API",
          version: "1.0.0",
          description: "API de estimativa AWS (Bun + Elysia)",
        },
      },
      path: "/docs",
    }),
  )
  .get("/health", () => ({ ok: true }), {
    detail: {
      summary: "Healthcheck",
      tags: ["system"],
    },
  })
  .get(
    "/api/aws/estimate",
    ({ query }) => {
      const lojas = toNumber(query.lojas);
      const instanciasAws = Math.max(1, Math.floor(toNumber(query.instanciasAws) || 1));
      const aws = estimateAWS(lojas, instanciasAws);

      return {
        input: {
          lojas,
          instanciasAws,
        },
        aws,
        awsMedia: (aws.min + aws.max) / 2,
        moeda: "BRL",
      };
    },
    {
      query: t.Object({
        lojas: t.Optional(t.Union([t.Number(), t.String()])),
        instanciasAws: t.Optional(t.Union([t.Number(), t.String()])),
      }),
      detail: {
        summary: "Estimativa AWS por querystring",
        tags: ["aws"],
      },
    },
  )
  .post(
    "/api/aws/estimate",
    ({ body }) => {
      const lojas = toNumber(body.lojas);
      const instanciasAws = Math.max(1, Math.floor(toNumber(body.instanciasAws) || 1));
      const aws = estimateAWS(lojas, instanciasAws);

      return {
        input: {
          lojas,
          instanciasAws,
        },
        aws,
        awsMedia: (aws.min + aws.max) / 2,
        moeda: "BRL",
      };
    },
    {
      body: t.Object({
        lojas: t.Optional(t.Union([t.Number(), t.String()])),
        instanciasAws: t.Optional(t.Union([t.Number(), t.String()])),
      }),
      detail: {
        summary: "Estimativa AWS por JSON",
        tags: ["aws"],
      },
    },
  )
  .get(
    "/api/aws/estimate-live",
    async ({ query, set }) => {
      try {
        const lojas = toNumber(query.lojas);
        const instanciasAws = Math.max(1, Math.floor(toNumber(query.instanciasAws) || 3));
        const regionCode = String(query.regionCode || "us-east-1");
        const ec2InstanceType = String(query.ec2InstanceType || query.ec2Preset || "t4g.large");
        const rdsInstanceType = String(query.rdsInstanceType || query.rdsPreset || "db.t4g.large");
        const rdsMultiAz = String(query.rdsMultiAz || "true") !== "false";
        const usdToBrlFromQuery = Math.max(0, toNumber(query.usdToBrl));
        let usdToBrl = usdToBrlFromQuery;
        let exchangeRateSource = "query";
        let exchangeRateMeta: Record<string, unknown> = {};

        if (!(usdToBrl > 0)) {
          const fx = await fetchUsdBrlRateOnline();
          usdToBrl = fx.usdToBrl;
          exchangeRateSource = "online";
          exchangeRateMeta = {
            bid: fx.bid,
            ask: fx.ask,
            createDate: fx.createDate,
            endpoint: fx.source,
          };
        }

        const live = await estimateAwsPublic({
          lojas,
          instanciasAws,
          regionCode,
          ec2InstanceType,
          rdsInstanceType,
          rdsMultiAz,
          usdToBrl,
        });

        return {
          input: {
            lojas,
            instanciasAws,
            regionCode,
            ec2InstanceType,
            rdsInstanceType,
            rdsMultiAz,
            usdToBrl,
            exchangeRateSource,
            exchangeRateMeta,
          },
          ...live,
          moeda: "BRL",
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao consultar estimativa AWS pública",
          details: error instanceof Error ? error.message : String(error),
          hint: "Verifique conectividade com AWS Price List pública e API de câmbio online.",
        };
      }
    },
    {
      query: t.Object({
        lojas: t.Optional(t.Union([t.Number(), t.String()], { description: "Quantidade de lojas (informativo na estimativa)." })),
        instanciasAws: t.Optional(t.Union([t.Number(), t.String()], { description: "Quantidade de instâncias EC2. Mínimo efetivo: 1." })),
        regionCode: t.Optional(
          t.String({
            enum: [...REGION_ENUM],
            description: "Região AWS (enum com regiões mais usadas).",
          }),
        ),
        ec2Preset: t.Optional(
          t.String({
            enum: [...EC2_PRESET_ENUM],
            description: "Preset de instância EC2 (enum). Ignorado se ec2InstanceType for enviado.",
          }),
        ),
        ec2InstanceType: t.Optional(t.String({ description: "Tipo da instância EC2 livre (override do preset)." })),
        rdsPreset: t.Optional(
          t.String({
            enum: [...RDS_PRESET_ENUM],
            description: "Preset de instância RDS (enum). Ignorado se rdsInstanceType for enviado.",
          }),
        ),
        rdsInstanceType: t.Optional(t.String({ description: "Tipo da instância RDS livre (override do preset)." })),
        rdsMultiAz: t.Optional(
          t.Union(
            [t.Boolean(), t.String({ enum: ["true", "false"] })],
            { description: "Se true, calcula RDS como 2x Single-AZ." },
          ),
        ),
        usdToBrl: t.Optional(t.Union([t.Number(), t.String()], { description: "Cotação manual USD/BRL. Se omitido, busca online na AwesomeAPI." })),
      }),
      detail: {
        summary: "Estimativa AWS ao vivo via AWS Price List pública (sem API key)",
        description:
          "Não requer API key AWS. Busca preços On-Demand na AWS Price List pública (Bulk API) e câmbio USD/BRL online. Se preço/câmbio falhar, retorna erro sem fallback numérico irreal.",
        tags: ["aws-live"],
      },
    },
  )
  .get(
    "/api/aws/public/offers",
    async ({ set }) => {
      try {
        const offers = await loadAwsOffersIndex();
        return {
          source: `${AWS_PRICING_PUBLIC_BASE}/offers/v1.0/aws/index.json`,
          publicationDate: offers.publicationDate || null,
          offerCodes: Object.keys(offers.offers || {}).sort(),
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao consultar catálogo público de ofertas AWS",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      detail: {
        summary: "Lista serviços/ofertas da AWS Price List pública",
        tags: ["aws-live"],
      },
    },
  )
  .get(
    "/api/aws/public/regions",
    async ({ query, set }) => {
      try {
        const serviceCode = String(query.serviceCode || "AmazonEC2");
        const regionIndex = await loadAwsServiceRegionIndex(serviceCode);
        return {
          serviceCode,
          source: `${AWS_PRICING_PUBLIC_BASE}/offers/v1.0/aws/${serviceCode}/current/region_index.json`,
          publicationDate: regionIndex.publicationDate || null,
          regionCodes: Object.keys(regionIndex.regions || {}).sort(),
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao consultar regiões da oferta pública AWS",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      query: t.Object({
        serviceCode: t.Optional(t.String({ description: "OfferCode do serviço (ex.: AmazonEC2, AmazonRDS, AmazonS3, AWSELB)." })),
      }),
      detail: {
        summary: "Lista regiões disponíveis por serviço (Price List pública)",
        tags: ["aws-live"],
      },
    },
  )
  .post(
    "/api/aws/public/search",
    async ({ body, set }) => {
      try {
        const serviceCode = String(body.serviceCode || "AmazonEC2");
        const regionCode = String(body.regionCode || "us-east-1");
        const limit = Math.max(1, Math.min(100, Math.floor(toNumber(body.limit) || 20)));
        const filters = body.filters || {};
        const doc = await loadAwsRegionPriceDoc(serviceCode, regionCode);
        const matches = findProductsByFilters(doc.doc, filters, limit);

        return {
          serviceCode,
          regionCode,
          filters,
          resultCount: matches.length,
          dataSource: {
            url: doc.url,
            publicationDate: doc.doc.publicationDate || null,
          },
          matches,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao buscar produtos na Price List pública",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      body: t.Object({
        serviceCode: t.String({ description: "OfferCode do serviço (ex.: AmazonEC2, AmazonRDS, AmazonS3, AWSELB)." }),
        regionCode: t.String({ description: "Região AWS (ex.: us-east-1)." }),
        limit: t.Optional(t.Union([t.Number(), t.String()])),
        filters: t.Optional(t.Record(t.String(), t.String(), { description: "Mapa atributo=valor exato da Price List pública." })),
      }),
      detail: {
        summary: "Busca produtos por filtros exatos na Price List pública",
        description:
          "Use esta rota para descobrir SKUs e dimensões de preço de qualquer serviço público da AWS (ex.: ALB, S3, EC2, RDS).",
        tags: ["aws-live"],
      },
    },
  )
  .post(
    "/api/aws/public/quote",
    async ({ body, set }) => {
      try {
        const usdToBrlFromBody = Math.max(0, toNumber(body.usdToBrl));
        let usdToBrl = usdToBrlFromBody;
        let exchangeRateSource = "body";
        let exchangeRateMeta: Record<string, unknown> = {};

        if (!(usdToBrl > 0)) {
          const fx = await fetchUsdBrlRateOnline();
          usdToBrl = fx.usdToBrl;
          exchangeRateSource = "online";
          exchangeRateMeta = {
            bid: fx.bid,
            ask: fx.ask,
            createDate: fx.createDate,
            endpoint: fx.source,
          };
        }

        const items = body.items || [];
        const lines: Array<Record<string, unknown>> = [];
        let totalUsd = 0;

        for (const item of items) {
          const serviceCode = String(item.serviceCode || "");
          const regionCode = String(item.regionCode || "us-east-1");
          const usageMode = String(item.usageMode || "monthly-hours");
          const usageAmount = Math.max(0, toNumber(item.usageAmount) || 1);
          const hoursPerMonth = Math.max(1, toNumber(item.hoursPerMonth) || HOURS_PER_MONTH);
          const filters = item.filters || {};

          const doc = await loadAwsRegionPriceDoc(serviceCode, regionCode);
          const match = findProductsByFilters(doc.doc, filters, 1)[0];
          if (!match) {
            lines.push({
              name: item.name || `${serviceCode}-${regionCode}`,
              serviceCode,
              regionCode,
              filters,
              error: "Nenhum SKU encontrado com esses filtros.",
            });
            continue;
          }

          const firstRate = match.priceDimensions.find((p) => Number.isFinite(p.rateUsd)) || { rateUsd: 0, unit: "Unknown", description: "" };
          const effectiveUsage = usageMode === "monthly-hours" ? usageAmount * hoursPerMonth : usageAmount;
          const lineUsd = firstRate.rateUsd * effectiveUsage;
          totalUsd += lineUsd;

          lines.push({
            name: item.name || `${serviceCode}-${regionCode}`,
            serviceCode,
            regionCode,
            filters,
            dataSourceUrl: doc.url,
            sku: match.sku,
            unit: firstRate.unit,
            rateUsd: firstRate.rateUsd,
            usageMode,
            usageAmount,
            hoursPerMonth: usageMode === "monthly-hours" ? hoursPerMonth : undefined,
            effectiveUsage,
            lineUsd,
            lineBrl: lineUsd * usdToBrl,
          });
        }

        return {
          source: "aws-public-price-list-bulk-api",
          exchangeRate: {
            usdToBrl,
            source: exchangeRateSource,
            meta: exchangeRateMeta,
          },
          totals: {
            usd: totalUsd,
            brl: totalUsd * usdToBrl,
          },
          lines,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao gerar orçamento estimado",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      body: t.Object({
        usdToBrl: t.Optional(t.Union([t.Number(), t.String()], { description: "Opcional. Se omitido, consulta online." })),
        items: t.Array(
          t.Object({
            name: t.Optional(t.String()),
            serviceCode: t.String({ description: "OfferCode do serviço (ex.: AmazonEC2, AmazonRDS, AmazonS3, AWSELB)." }),
            regionCode: t.Optional(t.String({ description: "Região AWS. Default: us-east-1." })),
            usageMode: t.Optional(t.String({ enum: ["monthly-hours", "direct"], description: "monthly-hours = rate * usageAmount * hoursPerMonth; direct = rate * usageAmount." })),
            usageAmount: t.Optional(t.Union([t.Number(), t.String()], { description: "Quantidade base da linha (instâncias, GB, requisições em milhares, etc)." })),
            hoursPerMonth: t.Optional(t.Union([t.Number(), t.String()], { description: "Só usado em monthly-hours. Default: 730." })),
            filters: t.Record(t.String(), t.String(), { description: "Filtros exatos de atributos da Price List pública para achar SKU." }),
          }),
        ),
      }),
      detail: {
        summary: "Gera orçamento estimado multi-serviço usando Price List pública",
        description:
          "Permite compor orçamento com ALB, S3, EC2, RDS e outros serviços da AWS. Sem API key. Use /public/search para descobrir filtros por serviço.",
        tags: ["aws-live"],
      },
    },
  )
  .get(
    "/api/hcloud/locations",
    async ({ headers, set }) => {
      try {
        const token = resolveHcloudToken(headers as Record<string, string | undefined>);
        const data = await fetchHcloudJson<{ locations?: Array<{ id: number; name: string; city?: string; country?: string; network_zone?: string }> }>(
          "/locations?per_page=200",
          token,
        );
        return {
          source: `${HCLOUD_API_BASE}/locations`,
          items: data.locations || [],
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao consultar localizações hcloud",
          details: error instanceof Error ? error.message : String(error),
          hint: "A API hcloud exige token Bearer. Use header x-hcloud-token ou HCLOUD_TOKEN no ambiente.",
        };
      }
    },
    {
      detail: {
        summary: "Lista localizações do hcloud",
        description: "Requer token hcloud (Bearer).",
        tags: ["hcloud"],
      },
    },
  )
  .get(
    "/api/hcloud/server-types",
    async ({ query, headers, set }) => {
      try {
        const token = resolveHcloudToken(headers as Record<string, string | undefined>);
        const location = query.location ? String(query.location) : "";
        const list = await loadHcloudServerTypes(token);
        const items = list.map((s) => {
          const hourlyNet = getHcloudRateEur(s.prices, location || undefined, "hourly");
          const monthlyNet = getHcloudRateEur(s.prices, location || undefined, "monthly");
          return {
            id: s.id,
            name: s.name,
            description: s.description || null,
            cpuType: s.cpu_type || null,
            architecture: s.architecture || null,
            cores: s.cores || null,
            memoryGb: s.memory || null,
            diskGb: s.disk || null,
            location: location || null,
            hourlyEurNet: hourlyNet,
            monthlyEurNet: monthlyNet,
            prices: s.prices || [],
          };
        });
        return {
          source: `${HCLOUD_API_BASE}/server_types`,
          location: location || null,
          items,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao consultar server types hcloud",
          details: error instanceof Error ? error.message : String(error),
          hint: "A API hcloud exige token Bearer. Use header x-hcloud-token ou HCLOUD_TOKEN no ambiente.",
        };
      }
    },
    {
      query: t.Object({
        location: t.Optional(t.String({ enum: [...HCLOUD_LOCATION_ENUM], description: "Filtra preço por localização (ex.: fsn1)." })),
      }),
      detail: {
        summary: "Lista server types hcloud com preços",
        description: "Requer token hcloud (Bearer). Retorna preço em EUR (net).",
        tags: ["hcloud"],
      },
    },
  )
  .get(
    "/api/hcloud/load-balancer-types",
    async ({ query, headers, set }) => {
      try {
        const token = resolveHcloudToken(headers as Record<string, string | undefined>);
        const location = query.location ? String(query.location) : "";
        const list = await loadHcloudLoadBalancerTypes(token);
        const items = list.map((s) => {
          const hourlyNet = getHcloudRateEur(s.prices, location || undefined, "hourly");
          const monthlyNet = getHcloudRateEur(s.prices, location || undefined, "monthly");
          return {
            id: s.id,
            name: s.name,
            description: s.description || null,
            maxConnections: s.max_connections || null,
            maxServices: s.max_services || null,
            maxTargets: s.max_targets || null,
            location: location || null,
            hourlyEurNet: hourlyNet,
            monthlyEurNet: monthlyNet,
            prices: s.prices || [],
          };
        });
        return {
          source: `${HCLOUD_API_BASE}/load_balancer_types`,
          location: location || null,
          items,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao consultar load balancer types hcloud",
          details: error instanceof Error ? error.message : String(error),
          hint: "A API hcloud exige token Bearer. Use header x-hcloud-token ou HCLOUD_TOKEN no ambiente.",
        };
      }
    },
    {
      query: t.Object({
        location: t.Optional(t.String({ enum: [...HCLOUD_LOCATION_ENUM], description: "Filtra preço por localização (ex.: fsn1)." })),
      }),
      detail: {
        summary: "Lista load balancer types hcloud com preços",
        description: "Requer token hcloud (Bearer). Retorna preço em EUR (net).",
        tags: ["hcloud"],
      },
    },
  )
  .post(
    "/api/hcloud/quote",
    async ({ body, headers, set }) => {
      try {
        const token = resolveHcloudToken(headers as Record<string, string | undefined>);
        const serverTypes = await loadHcloudServerTypes(token);
        const lbTypes = await loadHcloudLoadBalancerTypes(token);

        const eurToBrlBody = Math.max(0, toNumber(body.eurToBrl));
        let eurToBrl = eurToBrlBody;
        let exchangeRateSource = "body";
        let exchangeRateMeta: Record<string, unknown> = {};

        if (!(eurToBrl > 0)) {
          const fx = await fetchEurBrlRateOnline();
          eurToBrl = fx.eurToBrl;
          exchangeRateSource = "online";
          exchangeRateMeta = {
            bid: fx.bid,
            ask: fx.ask,
            createDate: fx.createDate,
            endpoint: fx.source,
          };
        }

        const items = body.items || [];
        const lines: Array<Record<string, unknown>> = [];
        let totalEur = 0;

        for (const item of items) {
          const kind = String(item.kind || "");
          const typeName = String(item.typeName || "");
          const location = String(item.location || "");
          const billing = (String(item.billing || "monthly").toLowerCase() === "hourly" ? "hourly" : "monthly") as "hourly" | "monthly";
          const quantity = Math.max(0, toNumber(item.quantity) || 1);
          const hoursPerMonth = Math.max(1, toNumber(item.hoursPerMonth) || HOURS_PER_MONTH);

          const catalog = kind === "load_balancer" ? lbTypes : serverTypes;
          const typeInfo = catalog.find((x) => x.name === typeName);
          if (!typeInfo) {
            lines.push({
              kind,
              typeName,
              location,
              error: "Tipo não encontrado no catálogo hcloud.",
            });
            continue;
          }

          const rateEurBase = getHcloudRateEur(typeInfo.prices, location || undefined, billing);
          if (!(rateEurBase > 0)) {
            lines.push({
              kind,
              typeName,
              location,
              error: "Preço não encontrado para a localização/tipo informados.",
            });
            continue;
          }

          const effectiveQuantity = billing === "hourly" ? quantity * hoursPerMonth : quantity;
          const lineEur = rateEurBase * effectiveQuantity;
          totalEur += lineEur;

          lines.push({
            kind,
            typeName,
            location: location || null,
            billing,
            quantity,
            hoursPerMonth: billing === "hourly" ? hoursPerMonth : undefined,
            unitRateEurNet: rateEurBase,
            lineEur,
            lineBrl: lineEur * eurToBrl,
          });
        }

        return {
          source: "hcloud-api",
          dataSource: HCLOUD_API_BASE,
          exchangeRate: {
            eurToBrl,
            source: exchangeRateSource,
            meta: exchangeRateMeta,
          },
          totals: {
            eur: totalEur,
            brl: totalEur * eurToBrl,
          },
          lines,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao gerar orçamento hcloud",
          details: error instanceof Error ? error.message : String(error),
          hint: "A API hcloud exige token Bearer. Use header x-hcloud-token ou HCLOUD_TOKEN no ambiente.",
        };
      }
    },
    {
      body: t.Object({
        eurToBrl: t.Optional(t.Union([t.Number(), t.String()], { description: "Opcional. Se omitido, consulta câmbio EUR/BRL online." })),
        items: t.Array(
          t.Object({
            kind: t.String({ enum: ["server", "load_balancer"], description: "Tipo de recurso hcloud." }),
            typeName: t.String({ description: "Nome do tipo (ex.: cpx21, cx22, lb11)." }),
            location: t.Optional(t.String({ enum: [...HCLOUD_LOCATION_ENUM], description: "Localização (ex.: fsn1)." })),
            billing: t.Optional(t.String({ enum: [...HCLOUD_BILLING_ENUM], description: "hourly ou monthly." })),
            quantity: t.Optional(t.Union([t.Number(), t.String()], { description: "Quantidade de unidades." })),
            hoursPerMonth: t.Optional(t.Union([t.Number(), t.String()], { description: "Só usado quando billing=hourly. Default 730." })),
          }),
        ),
      }),
      detail: {
        summary: "Gera orçamento estimado hcloud (server + load balancer)",
        description:
          "Rotas separadas por provider. Esta rota usa apenas hcloud API e exige token Bearer. Retorna valores em EUR (net) e BRL.",
        tags: ["hcloud"],
      },
    },
  )
  .get(
    "/api/hadcloud/plans",
    async ({ set }) => {
      try {
        const data = await loadHadCloudPlans();
        return {
          provider: "hadcloud",
          source: data.source,
          fetchedAt: data.fetchedAt,
          plans: data.plans,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao consultar planos públicos da HADCloud",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      detail: {
        summary: "Lista planos públicos de Cloud Server da HADCloud",
        description: "Dados extraídos da página pública da HADCloud (sem API key).",
        tags: ["hadcloud"],
      },
    },
  )
  .post(
    "/api/hadcloud/quote",
    async ({ body, set }) => {
      try {
        const catalog = await loadHadCloudPlans();
        const items = body.items || [];
        const lines: Array<Record<string, unknown>> = [];
        let totalBrl = 0;

        for (const item of items) {
          const planCode = String(item.planCodeCustom || item.planCode || "");
          const quantity = Math.max(0, toNumber(item.quantity) || 1);
          const months = Math.max(1, toNumber(item.months) || 1);

          const plan = catalog.plans.find((p) => p.planCode === planCode);
          if (!plan) {
            lines.push({
              planCode,
              error: "Plano não encontrado no catálogo público da HADCloud.",
            });
            continue;
          }

          const lineBrl = plan.monthlyBrl * quantity * months;
          totalBrl += lineBrl;
          lines.push({
            planCode: plan.planCode,
            monthlyBrl: plan.monthlyBrl,
            quantity,
            months,
            cpu: plan.cpu,
            ramGb: plan.ramGb,
            storageGb: plan.storageGb,
            lineBrl,
          });
        }

        return {
          provider: "hadcloud",
          source: catalog.source,
          fetchedAt: catalog.fetchedAt,
          totals: {
            brl: totalBrl,
          },
          lines,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao gerar orçamento HADCloud",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      body: t.Object({
        items: t.Array(
          t.Object({
            planCode: t.Optional(
              t.String({
                enum: [...HADCLOUD_PLAN_ENUM],
                description: "Plano HADCloud (enum dos planos públicos atuais).",
              }),
            ),
            planCodeCustom: t.Optional(t.String({ description: "Código livre para plano novo fora do enum atual." })),
            quantity: t.Optional(t.Union([t.Number(), t.String()], { description: "Quantidade de servidores desse plano." })),
            months: t.Optional(t.Union([t.Number(), t.String()], { description: "Período em meses para estimativa." })),
          }),
        ),
      }),
      detail: {
        summary: "Gera orçamento estimado HADCloud por plano",
        description:
          "Rotas separadas por provider. Calcula orçamento com base nos preços mensais públicos da HADCloud (cloud-server).",
        tags: ["hadcloud"],
      },
    },
  )
  .get(
    "/api/hadcloud/shared-plans",
    async ({ set }) => {
      try {
        const data = await loadHadCloudSharedPlans();
        return {
          provider: "hadcloud",
          category: "shared-hosting",
          source: data.source,
          fetchedAt: data.fetchedAt,
          plans: data.plans,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao consultar planos públicos de hospedagem compartilhada da HADCloud",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      detail: {
        summary: "Lista planos públicos de Hospedagem de Sites da HADCloud",
        description: "Dados extraídos da página pública de hospedagem de sites da HADCloud.",
        tags: ["hadcloud"],
      },
    },
  )
  .post(
    "/api/hadcloud/shared-quote",
    async ({ body, set }) => {
      try {
        const catalog = await loadHadCloudSharedPlans();
        const items = body.items || [];
        const lines: Array<Record<string, unknown>> = [];
        let totalBrl = 0;

        for (const item of items) {
          const planName = String(item.planNameCustom || item.planName || "");
          const quantity = Math.max(0, toNumber(item.quantity) || 1);
          const months = Math.max(1, toNumber(item.months) || 1);

          const plan = catalog.plans.find((p) => p.planName === planName);
          if (!plan) {
            lines.push({
              planName,
              error: "Plano não encontrado no catálogo público de hospedagem compartilhada da HADCloud.",
            });
            continue;
          }

          const lineBrl = plan.monthlyBrl * quantity * months;
          totalBrl += lineBrl;
          lines.push({
            planName: plan.planName,
            monthlyBrl: plan.monthlyBrl,
            quantity,
            months,
            storageGb: plan.storageGb,
            lineBrl,
          });
        }

        return {
          provider: "hadcloud",
          category: "shared-hosting",
          source: catalog.source,
          fetchedAt: catalog.fetchedAt,
          totals: {
            brl: totalBrl,
          },
          lines,
        };
      } catch (error) {
        set.status = 500;
        return {
          error: "Falha ao gerar orçamento HADCloud compartilhado",
          details: error instanceof Error ? error.message : String(error),
        };
      }
    },
    {
      body: t.Object({
        items: t.Array(
          t.Object({
            planName: t.Optional(
              t.String({
                enum: [...HADCLOUD_SHARED_PLAN_ENUM],
                description: "Plano de hospedagem compartilhada HADCloud (enum dos planos públicos atuais).",
              }),
            ),
            planNameCustom: t.Optional(t.String({ description: "Nome livre para plano novo fora do enum atual." })),
            quantity: t.Optional(t.Union([t.Number(), t.String()], { description: "Quantidade de assinaturas desse plano." })),
            months: t.Optional(t.Union([t.Number(), t.String()], { description: "Período em meses para estimativa." })),
          }),
        ),
      }),
      detail: {
        summary: "Gera orçamento estimado HADCloud compartilhado por plano",
        description:
          "Rotas separadas por provider. Calcula orçamento com base nos preços mensais públicos da HADCloud (hospedagem de sites).",
        tags: ["hadcloud"],
      },
    },
  )
  .listen(port);

console.log(`API Bun+Elysia rodando em http://localhost:${app.server?.port}`);
console.log(`Scalar Docs em http://localhost:${app.server?.port}/docs`);
