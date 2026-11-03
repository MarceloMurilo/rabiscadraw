// Ready-made architecture components. Each one is a few SVG paths in a 100x100 box, drawn with
// rough.js so they match the hand-drawn look. The LLM and MCP agents pick one by `id` instead of
// sketching it from scratch. Shared by the browser and the server (no DOM here).

export const COLOR_NAMES = ['default', 'red', 'green', 'blue', 'yellow'] as const
export type ColorName = (typeof COLOR_NAMES)[number]

export const COLORS: Record<ColorName, { stroke: string; fill: string }> = {
  default: { stroke: '#1e1e1e', fill: 'transparent' },
  red: { stroke: '#c92a2a', fill: '#ffc9c9' },
  green: { stroke: '#2b8a3e', fill: '#b2f2bb' },
  blue: { stroke: '#1971c2', fill: '#a5d8ff' },
  yellow: { stroke: '#e67700', fill: '#ffec99' },
}

export interface IconDef {
  id: string
  label: string // default caption (pt-BR)
  hint: string // when to use it (shown to the LLM)
  color?: ColorName // default tint
  paths: string[]
}

const DIAMOND = 'M50 8 L92 50 L50 92 L8 50 Z'

export const ICONS: IconDef[] = [
  {
    id: 'database', label: 'Banco de dados', color: 'blue',
    hint: 'Relational or NoSQL database, any persistent data store',
    paths: ['M15 20 A35 10 0 0 1 85 20 A35 10 0 0 1 15 20 Z', 'M15 20 V78 A35 10 0 0 0 85 78 V20', 'M15 49 A35 10 0 0 0 85 49'],
  },
  {
    id: 'cache', label: 'Cache', color: 'yellow',
    hint: 'In-memory cache such as Redis or Memcached',
    paths: ['M12 12 H88 V88 H12 Z', 'M56 20 L30 56 H48 L42 80 L70 42 H52 Z'],
  },
  {
    id: 'storage', label: 'Storage', color: 'blue',
    hint: 'Object/file storage such as S3 or a blob bucket',
    paths: ['M18 24 A32 9 0 0 1 82 24 A32 9 0 0 1 18 24 Z', 'M18 24 L26 86 H74 L82 24'],
  },
  {
    id: 'server', label: 'Servidor',
    hint: 'A server, VM or host machine',
    paths: ['M14 14 H86 V42 H14 Z', 'M14 58 H86 V86 H14 Z', 'M24 28 H34', 'M24 72 H34', 'M64 28 H76', 'M64 72 H76'],
  },
  {
    id: 'service', label: 'Serviço', color: 'green',
    hint: 'A microservice or application component',
    paths: ['M50 6 L90 28 V72 L50 94 L10 72 V28 Z', 'M50 50 m-12 0 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0'],
  },
  {
    id: 'container', label: 'Container',
    hint: 'A container, pod or deployment unit (Docker, Kubernetes)',
    paths: ['M50 8 L90 28 V72 L50 92 L10 72 V28 Z', 'M10 28 L50 48 L90 28', 'M50 48 V92'],
  },
  {
    id: 'function', label: 'Função',
    hint: 'Serverless function (Lambda, Cloud Functions)',
    paths: ['M10 10 H90 V90 H10 Z', 'M32 24 H44 L70 78', 'M52 50 L30 78'],
  },
  {
    id: 'worker', label: 'Worker', color: 'green',
    hint: 'Background worker, scheduled job or batch processor',
    paths: ['M50 50 m-17 0 a17 17 0 1 0 34 0 a17 17 0 1 0 -34 0', 'M50 10 V26 M50 74 V90 M10 50 H26 M74 50 H90 M22 22 L33 33 M67 67 L78 78 M78 22 L67 33 M33 67 L22 78'],
  },
  {
    id: 'load_balancer', label: 'Load balancer', color: 'yellow',
    hint: 'Load balancer distributing traffic across instances',
    paths: ['M50 50 m-14 0 a14 14 0 1 0 28 0 a14 14 0 1 0 -28 0', 'M8 50 H36', 'M28 44 L36 50 L28 56', 'M64 50 L88 22', 'M64 50 H92', 'M64 50 L88 78'],
  },
  {
    id: 'api_gateway', label: 'API Gateway', color: 'yellow',
    hint: 'API gateway / reverse proxy / ingress in front of services',
    paths: ['M28 12 H72 L94 50 L72 88 H28 L6 50 Z', 'M30 50 H70', 'M62 42 L70 50 L62 58', 'M38 42 L30 50 L38 58'],
  },
  {
    id: 'gateway_exclusive', label: 'Gateway exclusivo (XOR)', color: 'yellow',
    hint: 'BPMN exclusive gateway: exactly one outgoing path is taken (a decision)',
    paths: [DIAMOND, 'M34 34 L66 66', 'M66 34 L34 66'],
  },
  {
    id: 'gateway_parallel', label: 'Gateway paralelo (AND)', color: 'yellow',
    hint: 'BPMN parallel gateway: all outgoing paths run at the same time (fork/join)',
    paths: [DIAMOND, 'M50 28 V72', 'M28 50 H72'],
  },
  {
    id: 'gateway_inclusive', label: 'Gateway inclusivo (OR)', color: 'yellow',
    hint: 'BPMN inclusive gateway: one or more outgoing paths are taken',
    paths: [DIAMOND, 'M50 50 m-18 0 a18 18 0 1 0 36 0 a18 18 0 1 0 -36 0'],
  },
  {
    id: 'queue', label: 'Fila', color: 'yellow',
    hint: 'Message queue or broker (SQS, RabbitMQ, Kafka topic)',
    paths: ['M8 30 H92 V70 H8 Z', 'M34 30 V70', 'M60 30 V70', 'M66 50 H86', 'M80 44 L86 50 L80 56'],
  },
  {
    id: 'user', label: 'Usuário',
    hint: 'A person or actor using the system',
    paths: ['M50 26 m-13 0 a13 13 0 1 0 26 0 a13 13 0 1 0 -26 0', 'M50 39 V66', 'M28 50 H72', 'M50 66 L32 92', 'M50 66 L68 92'],
  },
  {
    id: 'browser', label: 'Web app',
    hint: 'Web frontend running in a browser',
    paths: ['M8 18 H92 V84 H8 Z', 'M8 34 H92', 'M18 26 H20', 'M28 26 H30', 'M38 26 H40'],
  },
  {
    id: 'mobile', label: 'Mobile',
    hint: 'Mobile app or phone client',
    paths: ['M30 6 H70 V94 H30 Z', 'M30 20 H70', 'M30 80 H70', 'M46 88 H54'],
  },
  {
    id: 'cloud', label: 'Cloud',
    hint: 'A cloud provider, an external system or the internet',
    paths: ['M28 76 C8 76 6 50 26 48 C26 26 58 20 66 40 C88 34 98 66 78 76 Z'],
  },
  {
    id: 'cdn', label: 'CDN / DNS', color: 'blue',
    hint: 'CDN, DNS or any globally distributed edge network',
    paths: ['M50 50 m-40 0 a40 40 0 1 0 80 0 a40 40 0 1 0 -80 0', 'M10 50 H90', 'M50 10 C26 30 26 70 50 90', 'M50 10 C74 30 74 70 50 90', 'M18 28 Q50 38 82 28', 'M18 72 Q50 62 82 72'],
  },
  {
    id: 'firewall', label: 'Firewall', color: 'red',
    hint: 'Firewall, WAF or a security boundary',
    paths: ['M8 18 H92 V84 H8 Z', 'M8 40 H92', 'M8 62 H92', 'M40 18 V40', 'M70 40 V62', 'M30 62 V84'],
  },
  {
    id: 'auth', label: 'Autenticação', color: 'red',
    hint: 'Authentication/authorization, identity provider, secrets',
    paths: ['M24 44 H76 V90 H24 Z', 'M34 44 V30 A16 16 0 0 1 66 30 V44', 'M50 60 V74'],
  },
  {
    id: 'monitoring', label: 'Monitoramento',
    hint: 'Monitoring, logging, metrics or observability',
    paths: ['M12 12 V88 H90', 'M20 68 L38 46 L54 60 L84 24', 'M76 24 H84 V32'],
  },
  {
    id: 'email', label: 'E-mail / notificação',
    hint: 'Email, SMS or push notification service',
    paths: ['M8 22 H92 V78 H8 Z', 'M8 22 L50 56 L92 22'],
  },
  {
    id: 'search', label: 'Busca', color: 'blue',
    hint: 'Search engine or index (Elasticsearch, OpenSearch)',
    paths: ['M42 42 m-30 0 a30 30 0 1 0 60 0 a30 30 0 1 0 -60 0', 'M64 64 L90 90'],
  },
  {
    id: 'file', label: 'Arquivo',
    hint: 'A document, file or report',
    paths: ['M24 8 H62 L78 24 V92 H24 Z', 'M62 8 V24 H78', 'M34 46 H68', 'M34 62 H68'],
  },
  {
    id: 'llm', label: 'Modelo de IA / LLM', color: 'yellow',
    hint: 'A language model, ML model or AI provider (OpenAI, Claude, local model)',
    paths: ['M46 12 L55 40 L84 49 L55 58 L46 86 L37 58 L8 49 L37 40 Z', 'M80 8 V26', 'M71 17 H89'],
  },
  {
    id: 'agent', label: 'Agente de IA', color: 'yellow',
    hint: 'An AI agent, assistant or autonomous workflow that calls tools',
    paths: ['M20 32 H80 V78 H20 Z', 'M50 32 V16', 'M45 11 H55', 'M36 50 H40', 'M60 50 H64', 'M36 64 H64', 'M10 48 V62', 'M90 48 V62'],
  },
  {
    id: 'vector_db', label: 'Banco vetorial', color: 'blue',
    hint: 'Vector database or embeddings index (pgvector, Pinecone, Qdrant)',
    paths: ['M15 20 A35 10 0 0 1 85 20 A35 10 0 0 1 15 20 Z', 'M15 20 V78 A35 10 0 0 0 85 78 V20', 'M36 46 H38', 'M52 56 H54', 'M64 42 H66', 'M44 68 H46'],
  },
  {
    id: 'scheduler', label: 'Agendador / cron', color: 'green',
    hint: 'A scheduler, cron job or timer that triggers work periodically',
    paths: ['M50 50 m-40 0 a40 40 0 1 0 80 0 a40 40 0 1 0 -80 0', 'M50 24 V50 L68 62'],
  },
  {
    id: 'event_stream', label: 'Stream de eventos', color: 'yellow',
    hint: 'Event stream or log of events (Kafka, Kinesis, Pub/Sub topic)',
    paths: ['M8 28 H88', 'M78 18 L88 28 L78 38', 'M8 50 H88', 'M78 40 L88 50 L78 60', 'M8 72 H88', 'M78 62 L88 72 L78 82'],
  },
  {
    id: 'websocket', label: 'WebSocket / tempo real', color: 'yellow',
    hint: 'A persistent two-way connection (WebSocket, SSE, gRPC stream)',
    paths: ['M10 36 H90', 'M78 24 L90 36 L78 48', 'M90 64 H10', 'M22 52 L10 64 L22 76'],
  },
  {
    id: 'api', label: 'API', color: 'green',
    hint: 'A REST/GraphQL/gRPC API surface (an endpoint set, not a gateway)',
    paths: ['M38 12 Q24 12 24 26 V40 Q24 50 12 50 Q24 50 24 60 V74 Q24 88 38 88', 'M62 12 Q76 12 76 26 V40 Q76 50 88 50 Q76 50 76 60 V74 Q76 88 62 88'],
  },
  {
    id: 'cli', label: 'Terminal / CLI',
    hint: 'A command line interface, terminal or script',
    paths: ['M8 16 H92 V84 H8 Z', 'M22 36 L38 50 L22 64', 'M46 66 H70'],
  },
  {
    id: 'repository', label: 'Repositório Git',
    hint: 'A git repository or source control',
    paths: ['M30 20 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0', 'M30 80 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0', 'M70 34 m-8 0 a8 8 0 1 0 16 0 a8 8 0 1 0 -16 0', 'M30 28 V72', 'M30 62 C30 46 70 54 70 42'],
  },
  {
    id: 'pipeline', label: 'Pipeline CI/CD', color: 'green',
    hint: 'A build/deploy pipeline, CI/CD or ordered processing stages',
    paths: ['M4 38 H30 V62 H4 Z', 'M37 38 H63 V62 H37 Z', 'M70 38 H96 V62 H70 Z', 'M30 50 H37', 'M63 50 H70'],
  },
  {
    id: 'orchestrator', label: 'Orquestrador / workflow', color: 'green',
    hint: 'A workflow engine or orchestrator that coordinates steps (Airflow, Temporal, Step Functions, a state machine)',
    paths: ['M20 50 m-12 0 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0', 'M80 24 m-12 0 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0', 'M80 76 m-12 0 a12 12 0 1 0 24 0 a12 12 0 1 0 -24 0', 'M31 44 L70 28', 'M31 56 L70 72'],
  },
  {
    id: 'etl', label: 'Transformação / ETL', color: 'green',
    hint: 'Data transformation, ETL/ELT step, parser or converter',
    paths: ['M10 16 H90 L58 52 V84 L42 74 V52 Z'],
  },
  {
    id: 'key', label: 'Chave / segredo', color: 'red',
    hint: 'A key, secret, certificate or credentials store (KMS, Vault)',
    paths: ['M32 50 m-20 0 a20 20 0 1 0 40 0 a20 20 0 1 0 -40 0', 'M52 50 H92', 'M78 50 V64', 'M90 50 V60'],
  },
  {
    id: 'dashboard', label: 'Dashboard / relatório', color: 'blue',
    hint: 'A dashboard, BI report or analytics view',
    paths: ['M10 12 H90 V88 H10 Z', 'M26 72 V52', 'M42 72 V34', 'M58 72 V46', 'M74 72 V26'],
  },
  {
    id: 'payment', label: 'Pagamento', color: 'red',
    hint: 'Payments, billing or a payment provider',
    paths: ['M8 24 H92 V76 H8 Z', 'M8 42 H92', 'M20 62 H42'],
  },
  {
    id: 'session', label: 'Sessão / estado', color: 'blue',
    hint: 'In-memory session, application state or a stack of contexts',
    paths: ['M10 38 H72 V90 H10 Z', 'M20 26 H82 V78', 'M30 14 H92 V66'],
  },
  {
    id: 'cluster', label: 'Cluster', color: 'green',
    hint: 'A cluster or pool of nodes (Kubernetes, ECS, a worker fleet)',
    paths: ['M6 10 H94 V90 H6 Z', 'M18 24 H44 V46 H18 Z', 'M56 24 H82 V46 H56 Z', 'M18 56 H44 V78 H18 Z', 'M56 56 H82 V78 H56 Z'],
  },
  {
    id: 'library', label: 'Biblioteca / módulo',
    hint: 'A shared library, package or internal module (not a running service)',
    paths: ['M12 16 H34 V86 H12 Z', 'M40 16 H62 V86 H40 Z', 'M68 22 L88 16 L96 82 L76 88 Z'],
  },
  {
    id: 'device', label: 'Dispositivo / IoT',
    hint: 'A physical device, sensor or embedded board',
    paths: ['M26 26 H74 V74 H26 Z', 'M40 40 H60 V60 H40 Z', 'M38 12 V26', 'M50 12 V26', 'M62 12 V26', 'M38 74 V88', 'M50 74 V88', 'M62 74 V88', 'M12 38 H26', 'M12 50 H26', 'M12 62 H26', 'M74 38 H88', 'M74 50 H88', 'M74 62 H88'],
  },
  {
    id: 'third_party', label: 'API externa', color: 'red',
    hint: 'A third-party service or external API outside your control (Stripe, GitHub, Slack, a SaaS)',
    paths: ['M28 76 C8 76 6 50 26 48 C26 26 58 20 66 40 C88 34 98 66 78 76 Z', 'M44 46 L36 56 L44 66', 'M58 46 L66 56 L58 66'],
  },
]

export const iconById = (id?: string | null) => ICONS.find((i) => i.id === id)

// Soft tints for the boxes drawn around groups: light enough to sit behind the pieces, strong enough that
// each box reads as its own area. A group may name its color; the others take the next free one in order.
export const FRAME_COLOR_NAMES = ['blue', 'green', 'yellow', 'violet', 'red', 'teal'] as const
export type FrameColor = (typeof FRAME_COLOR_NAMES)[number]
export const FRAME_TINTS: Record<FrameColor, { stroke: string; fill: string }> = {
  blue: { stroke: '#4dabf7', fill: '#e7f5ff' },
  green: { stroke: '#51cf66', fill: '#ebfbee' },
  yellow: { stroke: '#fcc419', fill: '#fff9db' },
  violet: { stroke: '#9775fa', fill: '#f3f0ff' },
  red: { stroke: '#ff8787', fill: '#fff5f5' },
  teal: { stroke: '#38d9a9', fill: '#e6fcf5' },
}
/** One tint per group, in order: the color the group asked for, else the next one nobody took. */
export function frameTints(groups: { color?: string | null }[]) {
  const named = (g: { color?: string | null }) => (g.color && (FRAME_COLOR_NAMES as readonly string[]).includes(g.color) ? (g.color as FrameColor) : null)
  const taken = new Set(groups.map(named).filter((x): x is FrameColor => !!x))
  const free = FRAME_COLOR_NAMES.filter((n) => !taken.has(n))
  let k = 0
  return groups.map((g) => FRAME_TINTS[named(g) ?? free[k++ % Math.max(1, free.length)] ?? FRAME_COLOR_NAMES[0]])
}
