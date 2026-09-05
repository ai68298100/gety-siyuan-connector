import assert from 'node:assert/strict';
import SiYuanConnector from './index.ts';
import type { SiyuanBlock, SiyuanNotebook } from './siyuan-client.ts';

type TestState = {
	knownDocs?: Record<string, string>;
	lastUpdatedByNotebook?: Record<string, string>;
	lastMaxUpdated?: string;
	pendingRetry?: string[];
};

type TestClient = {
	lsNotebooks(): Promise<SiyuanNotebook[]>;
	listDocIds(notebookId: string): Promise<SiyuanBlock[]>;
	listDocBlocks(notebookId: string): Promise<SiyuanBlock[]>;
	listDocBlocksSince(
		notebookId: string,
		since: string,
	): Promise<SiyuanBlock[]>;
	listDocsByIds(ids: string[]): Promise<SiyuanBlock[]>;
	exportMdContent(id: string): Promise<{ hPath: string; content: string }>;
};

function makeDoc(
	id: string,
	box = 'nb-1',
	updated = '20260905120000',
): SiyuanBlock {
	return {
		id,
		type: 'd',
		content: `Document ${id}`,
		hpath: `/Notebook/Document ${id}`,
		path: `/${id}`,
		box,
		updated,
		created: updated,
	};
}

function createConnector(
	client: TestClient,
	lastState: TestState | null = null,
): SiYuanConnector {
	const connector = new SiYuanConnector();
	const internals = connector as unknown as {
		client: TestClient;
		lastState: TestState | null;
		signal: AbortSignal;
	};
	internals.client = client;
	internals.lastState = lastState;
	internals.signal = new AbortController().signal;
	return connector;
}

function baseClient(overrides: Partial<TestClient> = {}): TestClient {
	const notebook: SiyuanNotebook = {
		id: 'nb-1',
		name: 'Notebook',
		closed: false,
		icon: '1f4d4',
	};
	return {
		lsNotebooks: () => Promise.resolve([notebook]),
		listDocIds: () => Promise.resolve([]),
		listDocBlocks: () => Promise.resolve([]),
		listDocBlocksSince: () => Promise.resolve([]),
		listDocsByIds: () => Promise.resolve([]),
		exportMdContent: () => Promise.resolve({ hPath: '', content: 'content' }),
		...overrides,
	};
}

Deno.test('deletion-only polls persist the deletion checkpoint', async () => {
	const connector = createConnector(
		baseClient(),
		{
			knownDocs: { deleted: '20260905115900' },
			lastUpdatedByNotebook: { 'nb-1': '20260905115900' },
		},
	);

	const results = [];
	for await (const result of connector.poll()) results.push(result);

	assert.equal(results.length, 1);
	assert.deepEqual(results[0].updates, [{ kind: 'delete', id: 'deleted' }]);
	assert.deepEqual(
		(results[0].state as TestState).knownDocs,
		{},
	);
});

Deno.test('failed exports are retried without indexing an error document', async () => {
	const doc = makeDoc('failed');
	const connector = createConnector(
		baseClient({
			listDocIds: () => Promise.resolve([doc]),
			listDocBlocks: () => Promise.resolve([doc]),
			exportMdContent: () =>
				Promise.reject(new Error('temporary export failure')),
		}),
	);

	const result = (await connector.poll().next()).value;
	assert.deepEqual(result?.updates, []);
	assert.deepEqual((result?.state as TestState).pendingRetry, ['failed']);
	assert.deepEqual((result?.state as TestState).knownDocs, {});
});

Deno.test('batch checkpoints advance only through processed documents', async () => {
	const docs = Array.from({ length: 7 }, (_, index) =>
		makeDoc(
			`doc-${index + 1}`,
			'nb-1',
			`2026090512000${String(index + 1)}`,
		));
	const connector = createConnector(
		baseClient({
			listDocIds: () => Promise.resolve(docs),
			listDocBlocks: () => Promise.resolve(docs),
		}),
	);

	const first = (await connector.poll().next()).value;
	const state = first?.state as TestState;
	assert.equal(first?.updates.length, 6);
	assert.equal(state.lastUpdatedByNotebook?.['nb-1'], '20260905120006');
	assert.equal(Object.keys(state.knownDocs ?? {}).length, 6);
});

Deno.test('retrying a closed-notebook document keeps notebook metadata', async () => {
	const doc = makeDoc('retry', 'nb-closed');
	const closedNotebook: SiyuanNotebook = {
		id: 'nb-closed',
		name: 'Archived',
		closed: true,
		icon: '1f4d4',
	};
	const connector = createConnector(
		baseClient({
			lsNotebooks: () => Promise.resolve([closedNotebook]),
			listDocIds: () => Promise.resolve([doc]),
			listDocsByIds: () => Promise.resolve([doc]),
			exportMdContent: () => Promise.resolve({ hPath: '', content: 'content' }),
		}),
		{ pendingRetry: ['retry'] },
	);

	const result = (await connector.poll().next()).value;
	const update = result?.updates[0];
	assert.equal(update?.kind, 'upsert');
	if (update?.kind === 'upsert') {
		const metadata = update.doc.metadata as { notebook_name: string };
		assert.equal(metadata.notebook_name, 'Archived');
	}
});
