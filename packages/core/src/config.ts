import { z } from "zod";

const Env = z.object({
  // Claude. The key stays in the API process. It never reaches the browser or the agent subprocess.
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().default("claude-opus-5-5"),
  CLAUDE_GUARD_MODEL: z.string().default("claude-haiku-5-5"),

  // Privy sign-in. The app id is public. The app secret stays on the server.
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  PRIVY_VERIFICATION_KEY: z.string().optional(),
  // Server signer for the Privy wallet of a user (key quorum id and its P-256 private key). The deposit converter uses it.
  PRIVY_SIGNER_ID: z.string().optional(),
  PRIVY_AUTHORIZATION_KEY: z.string().optional(),
  // Gas sponsor (EIP-7702). One key, the same address on every EVM chain. It sends the transactions of the users and pays the gas.
  SPONSOR_PRIVATE_KEY: z.string().optional(),
  SPONSOR_DAILY_TXS: z.coerce.number().default(200),
  // Scheduled jobs: how often the server reads the conditions.
  JOB_INTERVAL_SECONDS: z.coerce.number().default(15),
  // The deposit converter: how often it looks, and the smallest value it converts.
  DEPOSIT_SWEEP_SECONDS: z.coerce.number().default(60),
  DEPOSIT_MIN_USD: z.coerce.number().default(1),

  DATABASE_URL: z.string().default("postgres://localhost:5432/defi_agent"),
  API_PORT: z.coerce.number().default(8787),
  LLM_PROXY_PORT: z.coerce.number().default(8788),
  WORKSPACES_DIR: z.string().default("./workspaces"),

  // MPP on Tempo mainnet.
  MPP_ENABLED: z.enum(["true", "false"]).default("false"),
  MPP_SECRET_KEY: z.string().optional(),
  MPP_RECIPIENT: z.string().optional(),
  MPP_SERVER_PRIVATE_KEY: z.string().optional(),

  // Pricing. All amounts are USD.
  // One flat price for each prompt. Actions and guard time are free for now.
  PRICE_PROMPT_USD: z.coerce.number().default(0.01),
  PRICE_ACTION_USD: z.coerce.number().default(0),
  PRICE_GUARD_MINUTE_USD: z.coerce.number().default(0),
  USER_DAILY_LLM_BUDGET_USD: z.coerce.number().default(50),
  USER_PROMPTS_PER_MINUTE: z.coerce.number().default(10),

  // RPC endpoints. Public defaults work for reads. Use paid endpoints for execution.
  RPC_ETHEREUM: z.string().default("https://ethereum-rpc.publicnode.com"),
  RPC_ARBITRUM: z.string().default("https://arb1.arbitrum.io/rpc"),
  // The publicnode endpoint refuses a gas estimate for a sponsored transaction ("archive request"). The official endpoints accept it.
  RPC_BASE: z.string().default("https://mainnet.base.org"),
  RPC_ROBINHOOD: z.string().default("https://rpc.mainnet.chain.robinhood.com"),
  RPC_TEMPO: z.string().default("https://rpc.tempo.xyz"),
  RPC_HYPEREVM: z.string().default("https://rpc.hyperliquid.xyz/evm"),
  RPC_SOLANA: z.string().default("https://api.mainnet-beta.solana.com"),

  // Signers held by the API and guard processes only.
  KEY_ENCRYPTION_SECRET: z.string().optional(),
  HL_BUILDER_ADDRESS: z.string().optional(),
  HL_BUILDER_FEE_TENTH_BPS: z.coerce.number().default(10),
  AAVE_KEEPER_PRIVATE_KEY: z.string().optional(),
  SOLANA_AGENT_KEYPAIR: z.string().optional(),
  VAULT_PROGRAM_ID: z.string().optional(),
  DFLOW_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;
export function config(): Config {
  // An empty value in .env means "not set". The default then applies.
  cached ??= Env.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
  return cached;
}
