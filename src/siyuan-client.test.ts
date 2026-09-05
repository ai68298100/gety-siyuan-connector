import assert from 'node:assert/strict';
import { SiYuanClient, SiYuanError } from './siyuan-client.ts';

/**
 * Captures the last SQL statement sent to /api/query/sql by mocking fetch.
 */
function createClientWithCapture() {
	const captured: { sql: string; token?: string }[] = [];
	const client = new SiYuanClient('http://localhost:6806', 'tok-123', {
		aborted: false,
	} as AbortSignal);

	// Override the private post() by reaching through the prototype chain is
	// not possible; instead patch globalThis.fetch used by the client.
	const realFetch = globalThis.fetch;
	globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		if (url.endsWith('/api/query/sql')) {
			const headers = init?.headers as Record<string, string> | undefined;
			captured.push({ sql: body.stmt, token: headers?.['Authorization'] });
			return Promise.resolve(
				new Response(
					JSON.stringify({ code: 0, msg: '', data: [] }),
					{ status: 200, headers: { 'Content-Type': 'application/json' } },
				),
			);
		}
		return realFetch(input, init);
	};

	return {
		client,
		captured,
		restore: () => {
			globalThis.fetch = realFetch;
		},
	};
}

Deno.test('listDocsByIds returns empty for no ids', async () => {
	const { client, restore } = createClientWithCapture();
	try {
		const result = await client.listDocsByIds([]);
		assert.equal(result.length, 0);
	} finally {
		restore();
	}
});

Deno.test('listDocsByIds builds an IN query with escaped ids', async () => {
	const { client, captured, restore } = createClientWithCapture();
	try {
		await client.listDocsByIds(['id-one', 'id-two']);
		assert.equal(captured.length, 1);
		assert.match(
			captured[0].sql,
			/WHERE type = 'd' AND id IN \('id-one', 'id-two'\)/,
		);
		assert.equal(captured[0].token, 'token tok-123');
	} finally {
		restore();
	}
});

Deno.test('listDocsByIds escapes single quotes in ids', async () => {
	const { client, captured, restore } = createClientWithCapture();
	try {
		await client.listDocsByIds(["it's-id"]);
		assert.equal(captured.length, 1);
		assert.match(captured[0].sql, /'it''s-id'/);
	} finally {
		restore();
	}
});

Deno.test('listDocBlocksSince includes the timestamp boundary', async () => {
	const { client, captured, restore } = createClientWithCapture();
	try {
		await client.listDocBlocksSince('nb-1', '20260905120000');
		assert.match(captured[0].sql, /AND updated >= '20260905120000'/);
	} finally {
		restore();
	}
});

Deno.test('post rejects an error envelope without a data field', async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = () =>
		Promise.resolve(
			new Response(JSON.stringify({ code: -1, msg: 'permission denied' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
	try {
		const client = new SiYuanClient('http://localhost:6806', undefined, {
			aborted: false,
		} as AbortSignal);
		await assert.rejects(
			() => client.version(),
			(error: unknown) =>
				error instanceof SiYuanError &&
				error.code === -1 &&
				error.message.includes('permission denied'),
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});
