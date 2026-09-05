// Direct test harness: load dist/main.js, inject config, call onLoad + poll.
// Bypasses runner.ts StartFrame to isolate connector code issues.

const entryUrl = new URL(
	'../dist/main.js',
	import.meta.url,
).href;
console.error('Loading connector from:', entryUrl);

const module = await import(entryUrl);
const ConnectorClass = module.default;
console.error('Connector class loaded:', typeof ConnectorClass);

if (typeof ConnectorClass !== 'function') {
	console.error('ERROR: connector entry must default-export a Connector class');
	Deno.exit(1);
}

const instance = new ConnectorClass();
const config = {
	api_url: Deno.env.get('GETY_CONFIG_API_URL') ?? 'http://localhost:6806',
	api_token: Deno.env.get('GETY_CONFIG_API_TOKEN') ?? '',
};
const internals = instance as {
	config: Record<string, unknown>;
	lastState: unknown;
	signal: AbortSignal;
	onLoad?(): Promise<void>;
	poll(): AsyncGenerator<unknown, void, unknown>;
};
internals.config = config;
internals.lastState = null;
internals.signal = new AbortController().signal;

console.error('Calling onLoad()...');
try {
	await instance.onLoad?.();
	console.error('onLoad() succeeded');
} catch (err) {
	console.error('onLoad() FAILED:', (err as Error).message);
	console.error('Stack:', (err as Error).stack);
	Deno.exit(1);
}

console.error('Calling poll()...');
let count = 0;
try {
	for await (const result of instance.poll()) {
		count++;
		console.error(
			`Poll result ${count}:`,
			JSON.stringify(result, null, 2).slice(0, 500),
		);
		if (count >= 3) break;
	}
	console.error(`poll() completed, yielded ${count} results`);
} catch (err) {
	console.error('poll() FAILED:', (err as Error).message);
	console.error('Stack:', (err as Error).stack);
}
