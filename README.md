# API AWS Calculator (Bun + Elysia)

API de alta performance com Bun + Elysia, baseada na regra de cálculo AWS já usada na calculadora do projeto.

## Rodar localmente

```bash
cp .env.example .env
bun install
bun run dev
```

Servidor padrão: `http://localhost:9876`

Scalar API Docs: `http://localhost:9876/docs`

## Endpoints

### Healthcheck

`GET /health`

Resposta:

```json
{ "ok": true }
```

### Estimativa AWS (GET)

`GET /api/aws/estimate?lojas=500&instanciasAws=3`

### Estimativa AWS (POST)

`POST /api/aws/estimate`

Body:

```json
{
  "lojas": 500,
  "instanciasAws": 3
}
```

### Estimativa AWS ao vivo (sem API key AWS)

`GET /api/aws/estimate-live?lojas=500&instanciasAws=3&regionCode=us-east-1&ec2InstanceType=t4g.large&rdsInstanceType=db.t4g.large&rdsMultiAz=true&usdToBrl=5.0`

Como funciona:

- Não usa credencial AWS, não usa IAM, não usa API key.
- Busca preços On-Demand na AWS Price List pública (Bulk API), por região/instância.
- Busca USD/BRL online na AwesomeAPI quando `usdToBrl` não é enviado.
- Se qualquer fonte externa falhar (AWS pública ou câmbio), retorna erro em vez de inventar valor.

Fontes de dados públicas usadas:

- AWS EC2 region index: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/region_index.json`
- AWS RDS region index: `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/region_index.json`
- Câmbio USD/BRL: `https://economia.awesomeapi.com.br/json/last/USD-BRL`

Limitações reais da estimativa:

- Preço calculado em cima de On-Demand (não inclui Savings Plans/Reserved/Spot).
- Multi-AZ do RDS é estimado como `2x Single-AZ`.
- Não inclui tráfego, EBS detalhado, snapshots, IOPS provisionado, licenças extras e impostos.
- Resultado depende da publicação mais recente dos arquivos públicos da AWS.

Referências oficiais AWS Price List pública:

- https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/price-changes.html
- https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api.html

### Catálogo público (todos os produtos possíveis)

- `GET /api/aws/public/offers`  
Lista os `offerCode` disponíveis (ex.: `AmazonEC2`, `AmazonRDS`, `AmazonS3`, `AWSELB`).

- `GET /api/aws/public/regions?serviceCode=AmazonS3`  
Lista as regiões suportadas para o serviço.

- `POST /api/aws/public/search`  
Busca SKUs e preços por filtros de atributos da Price List.

Exemplo body (`AWSELB`):

```json
{
  "serviceCode": "AWSELB",
  "regionCode": "us-east-1",
  "limit": 5,
  "filters": {
    "locationType": "AWS Region"
  }
}
```

### Orçamento estimado multi-serviço

`POST /api/aws/public/quote`

Use para orçamento com vários serviços (ALB + EC2 + S3 + RDS etc) em uma requisição.

Exemplo:

```json
{
  "items": [
    {
      "name": "EC2 app",
      "serviceCode": "AmazonEC2",
      "regionCode": "us-east-1",
      "usageMode": "monthly-hours",
      "usageAmount": 3,
      "hoursPerMonth": 730,
      "filters": {
        "instanceType": "t4g.large",
        "operatingSystem": "Linux",
        "preInstalledSw": "NA",
        "tenancy": "Shared",
        "capacitystatus": "Used",
        "regionCode": "us-east-1"
      }
    },
    {
      "name": "RDS MySQL",
      "serviceCode": "AmazonRDS",
      "regionCode": "us-east-1",
      "usageMode": "monthly-hours",
      "usageAmount": 1,
      "hoursPerMonth": 730,
      "filters": {
        "instanceType": "db.t4g.large",
        "databaseEngine": "MySQL",
        "deploymentOption": "Single-AZ",
        "regionCode": "us-east-1"
      }
    },
    {
      "name": "S3 storage",
      "serviceCode": "AmazonS3",
      "regionCode": "us-east-1",
      "usageMode": "direct",
      "usageAmount": 2000,
      "filters": {
        "group": "S3-API-Tier1",
        "regionCode": "us-east-1"
      }
    }
  ]
}
```

## Rotas hcloud (separadas por provider)

Observação importante:

- A API oficial hcloud exige token Bearer.
- Você pode passar token por header `x-hcloud-token` ou por `HCLOUD_TOKEN` no `.env`.

Como gerar token hcloud:

1. Acesse o Hetzner Cloud Console.
2. Entre no projeto desejado.
3. Vá em `Security` > `API Tokens`.
4. Crie um token com permissão de leitura para consulta de tipos/preços.

### Localizações hcloud

`GET /api/hcloud/locations`

### Server types hcloud (com preços)

`GET /api/hcloud/server-types?location=fsn1`

### Load balancer types hcloud (com preços)

`GET /api/hcloud/load-balancer-types?location=fsn1`

### Orçamento hcloud (server + load balancer)

`POST /api/hcloud/quote`

Exemplo body:

```json
{
  "items": [
    {
      "kind": "server",
      "typeName": "cpx21",
      "location": "fsn1",
      "billing": "monthly",
      "quantity": 3
    },
    {
      "kind": "load_balancer",
      "typeName": "lb11",
      "location": "fsn1",
      "billing": "monthly",
      "quantity": 1
    }
  ]
}
```

Headers:

- `x-hcloud-token: <seu_token>`

Se `eurToBrl` não for enviado no body, a API busca EUR/BRL online automaticamente.

## Rotas HADCloud (separadas por provider)

Observação importante:

- Essas rotas usam a página pública de Cloud Server da HADCloud como fonte.
- Não precisa token/API key para consulta.
- Como é extração da página pública, os planos podem mudar quando o site mudar.

### Planos públicos HADCloud

`GET /api/hadcloud/plans`

Retorna planos extraídos da página:

- código do plano
- valor mensal em BRL
- CPU/RAM/Storage (quando detectado)

### Orçamento HADCloud por plano

`POST /api/hadcloud/quote`

Exemplo body:

```json
{
  "items": [
    {
      "planCode": "HN1-1-10",
      "quantity": 2,
      "months": 1
    },
    {
      "planCode": "HM4-8-40",
      "quantity": 1,
      "months": 3
    }
  ]
}
```

Os planos principais estão enumerados no Scalar, e existe `planCodeCustom` para códigos novos fora do enum atual.

### Planos compartilhados HADCloud

`GET /api/hadcloud/shared-plans`

Retorna os planos públicos da página de hospedagem de sites (ex.: Had Basico, Had Plus, Had Max...).

### Orçamento HADCloud compartilhado

`POST /api/hadcloud/shared-quote`

Exemplo body:

```json
{
  "items": [
    {
      "planName": "Had Basico",
      "quantity": 3,
      "months": 1
    },
    {
      "planName": "Had Plus",
      "quantity": 1,
      "months": 12
    }
  ]
}
```

Os planos compartilhados também ficam enumerados no Scalar, e existe `planNameCustom` para novos nomes fora do enum atual.

## Produção

```bash
bun run start
```

Resposta:

```json
{
  "input": {
    "lojas": 500,
    "instanciasAws": 3
  },
  "aws": {
    "min": 1500,
    "max": 2000,
    "label": "Infra mínima"
  },
  "awsMedia": 1750,
  "moeda": "BRL"
}
```
