// PROTOTYPE ONLY: validates graph navigation in native VS Code Comment threads.
// This file is intentionally disposable and must not be merged as product code.
import * as vscode from 'vscode';

const controllerId = 'codealongai.prototype.nativeComments';

type StopId =
  | 'checkout-origin'
  | 'checkout-cart'
  | 'pricing-function'
  | 'pricing-reducer'
  | 'pricing-reducer-revisit';

interface PrototypeDestination {
  id: StopId;
  label: string;
  description: string;
}

interface PrototypeStop {
  id: StopId;
  title: string;
  document: 'checkout.ts' | 'pricing.ts';
  anchor: string;
  explanation: string;
  destinations: readonly PrototypeDestination[];
  next?: StopId;
  back?: StopId;
}

interface LiveStop extends PrototypeStop {
  thread: vscode.CommentThread;
}

const checkoutStop: PrototypeStop = {
  id: 'checkout-origin',
  title: 'Origin · subtotal call',
  document: 'checkout.ts',
  anchor: 'subtotal(cart)',
  explanation: [
    '**Origin · `subtotal(cart)`**',
    '',
    '`checkout.ts` asks `subtotal` to summarize the cart before displaying it.',
    '',
    'Use **Next** for the model-recommended route, or **Destinations** to inspect every branch.'
  ].join('\n'),
  next: 'pricing-function',
  destinations: [
    {
      id: 'pricing-function',
      label: 'Open the subtotal definition',
      description: 'Recommended · cross-file'
    },
    {
      id: 'pricing-reducer',
      label: 'Jump directly to the reducer operation',
      description: 'Alternative · cross-file'
    },
    {
      id: 'checkout-cart',
      label: 'Inspect the cart input first',
      description: 'Alternative · same file'
    }
  ]
};

const checkoutCartStop: PrototypeStop = {
  id: 'checkout-cart',
  title: 'Branch · cart input',
  document: 'checkout.ts',
  anchor: 'const cart = [12, 18]',
  explanation: [
    '**Branch · cart input**',
    '',
    'This is the concrete input passed to `subtotal`: two positive prices, `12` and `18`.',
    '',
    '**Next** rejoins the recommended route at the function definition.'
  ].join('\n'),
  next: 'pricing-function',
  back: 'checkout-origin',
  destinations: [
    {
      id: 'pricing-function',
      label: 'Continue to the subtotal definition',
      description: 'Recommended · cross-file'
    }
  ]
};

const pricingFunctionStop: PrototypeStop = {
  id: 'pricing-function',
  title: 'Definition · subtotal',
  document: 'pricing.ts',
  anchor: 'subtotal(prices: readonly number[])',
  explanation: [
    '**Definition · `subtotal`**',
    '',
    'The function accepts a read-only list of prices and promises to return one number.',
    '',
    '**Next** follows the deterministic route into the reducer operation.'
  ].join('\n'),
  next: 'pricing-reducer',
  back: 'checkout-origin',
  destinations: [
    {
      id: 'pricing-reducer',
      label: 'Inspect the reducer operation',
      description: 'Recommended · same file'
    }
  ]
};

const pricingReducerStop: PrototypeStop = {
  id: 'pricing-reducer',
  title: 'Reducer · first explanation',
  document: 'pricing.ts',
  anchor: 'total - price',
  explanation: [
    '**Reducer · first explanation**',
    '',
    'The reducer subtracts each price from an accumulator that starts at zero, so a positive cart produces a negative subtotal.',
    '',
    '**Next** deliberately creates another stop instance on this exact range.'
  ].join('\n'),
  next: 'pricing-reducer-revisit',
  back: 'pricing-function',
  destinations: [
    {
      id: 'pricing-reducer-revisit',
      label: 'Revisit this range from a second reasoning step',
      description: 'Recommended · duplicate range'
    }
  ]
};

const pricingReducerRevisitStop: PrototypeStop = {
  id: 'pricing-reducer-revisit',
  title: 'Reducer · second explanation',
  document: 'pricing.ts',
  anchor: 'total - price',
  explanation: [
    '**Reducer · second explanation on the same range**',
    '',
    'This is a distinct graph stop with its own native thread and conversation, even though it shares the exact `total - price` anchor.',
    '',
    'This stop is terminal, but **Back** follows its graph-defined edge to the first reducer explanation.'
  ].join('\n'),
  back: 'pricing-reducer',
  destinations: []
};

const stops = new Map<StopId, PrototypeStop>([
  [checkoutStop.id, checkoutStop],
  [checkoutCartStop.id, checkoutCartStop],
  [pricingFunctionStop.id, pricingFunctionStop],
  [pricingReducerStop.id, pricingReducerStop],
  [pricingReducerRevisitStop.id, pricingReducerRevisitStop]
]);

const codeAlongAi: vscode.CommentAuthorInformation = { name: 'CodeAlongAI' };
const human: vscode.CommentAuthorInformation = { name: 'You' };

function comment(
  author: vscode.CommentAuthorInformation,
  body: string | vscode.MarkdownString,
  label?: string
): vscode.Comment {
  return {
    author,
    body,
    label,
    mode: vscode.CommentMode.Preview,
    timestamp: new Date()
  };
}

function deterministicAnswer(stop: StopId, question: string): string {
  const normalized = question.toLowerCase();
  if (normalized.includes('edit') || normalized.includes('fix') || normalized.includes('change')) {
    return 'This walkthrough is read-only. I can explain the range, but I cannot propose or apply a code change.';
  }
  if (stop === 'checkout-origin' || stop === 'checkout-cart') {
    if (normalized.includes('where') || normalized.includes('subtotal') || normalized.includes('pricing')) {
      return '`subtotal` is defined in `pricing.ts`. Use **Next** when you want the graph-recommended route, or **Destinations** to choose another branch.';
    }
    return 'This call passes the current cart into `subtotal` and interpolates the returned number into the log message.';
  }
  if (normalized.includes('why') || normalized.includes('negative') || normalized.includes('wrong')) {
    return 'The accumulator begins at `0`, then every item is subtracted: `0 - 12 - 18` becomes `-30`.';
  }
  return 'This range is the reducer step. Each iteration combines `total` and `price` using subtraction.';
}

function rangeFor(document: vscode.TextDocument, anchor: string): vscode.Range {
  const offset = document.getText().indexOf(anchor);
  if (offset < 0) {
    throw new Error(`Prototype anchor not found: ${anchor}`);
  }
  return new vscode.Range(document.positionAt(offset), document.positionAt(offset + anchor.length));
}

export function registerNativeCommentThreadPrototype(
  context: vscode.ExtensionContext
): vscode.Disposable {
  const controller = vscode.comments.createCommentController(controllerId, 'CodeAlongAI walkthrough');
  controller.options = {
    prompt: 'Ask CodeAlongAI about this walkthrough stop',
    placeHolder: 'Type a question (try “Why is this negative?”)'
  };

  const output = vscode.window.createOutputChannel('CodeAlongAI Comment Prototype');
  const liveStops = new Map<StopId, LiveStop>();
  const threadStops = new Map<vscode.CommentThread, StopId>();
  let attention: StopId | undefined;

  const snapshot = (action: string): void => {
    const state = {
      action,
      humanOrigin: liveStops.has('checkout-origin') ? 'checkout-origin' : undefined,
      codeAlongAiAttention: attention,
      stops: [...stops.values()].map((stop) => ({
        id: stop.id,
        document: stop.document,
        anchor: stop.anchor,
        visited: liveStops.has(stop.id),
        recommendedNext: stop.next,
        graphBack: stop.back,
        destinations: stop.destinations.map((destination) => destination.id),
        thread: liveStops.has(stop.id)
          ? {
            commentCount: liveStops.get(stop.id)?.thread.comments.length,
            requestedState: liveStops.get(stop.id)?.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded
              ? 'expanded'
              : 'collapsed'
          }
          : undefined
      }))
    };
    output.appendLine(JSON.stringify(state, null, 2));
  };

  const workspaceDocument = async (name: PrototypeStop['document']): Promise<vscode.TextDocument> => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (workspace === undefined) {
      throw new Error('Open the demo-workspace folder before running this prototype.');
    }
    return vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace.uri, name));
  };

  const threadContext = (stop: PrototypeStop): string => [
    'codealongaiWalkthrough',
    stop.back === undefined ? undefined : 'hasBack',
    stop.next === undefined ? undefined : 'hasNext',
    stop.destinations.length === 0 ? undefined : 'hasDestinations'
  ].filter((part): part is string => part !== undefined).join('-');

  const ensureStop = async (stop: PrototypeStop): Promise<LiveStop> => {
    const existing = liveStops.get(stop.id);
    if (existing !== undefined) {
      return existing;
    }

    const document = await workspaceDocument(stop.document);
    const thread = controller.createCommentThread(
      document.uri,
      rangeFor(document, stop.anchor),
      [comment(codeAlongAi, new vscode.MarkdownString(stop.explanation), 'walkthrough')]
    );
    thread.label = `CodeAlongAI · ${stop.title}`;
    thread.contextValue = threadContext(stop);
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    const live = { ...stop, thread };
    liveStops.set(stop.id, live);
    threadStops.set(thread, stop.id);
    return live;
  };

  const showStop = async (stop: PrototypeStop): Promise<void> => {
    const originDocument = await workspaceDocument('checkout.ts');
    const targetDocument = await workspaceDocument(stop.document);
    const targetRange = rangeFor(targetDocument, stop.anchor);

    if (stop.document === 'pricing.ts') {
      await vscode.window.showTextDocument(originDocument, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: true,
        preview: false
      });
    }
    const editor = await vscode.window.showTextDocument(targetDocument, {
      viewColumn: stop.document === 'checkout.ts' ? vscode.ViewColumn.One : vscode.ViewColumn.Two,
      preserveFocus: false,
      preview: false
    });
    editor.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };

  const activateStop = async (stopId: StopId, action: string): Promise<void> => {
    const stop = stops.get(stopId);
    if (stop === undefined) {
      throw new Error(`Unknown prototype stop: ${stopId}`);
    }
    const target = await ensureStop(stop);
    await showStop(stop);
    for (const live of liveStops.values()) {
      live.thread.collapsibleState = live.id === stopId
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;
    }
    attention = stopId;
    snapshot(action);
  };

  const reset = (): void => {
    for (const stop of liveStops.values()) {
      stop.thread.dispose();
    }
    liveStops.clear();
    threadStops.clear();
    attention = undefined;
    snapshot('reset');
  };

  const start = async (): Promise<void> => {
    reset();
    await activateStop('checkout-origin', 'started walkthrough');
    output.show(true);
  };

  const stopForThread = (thread: vscode.CommentThread | undefined): PrototypeStop | undefined => {
    if (thread === undefined) {
      return undefined;
    }
    const id = threadStops.get(thread);
    return id === undefined ? undefined : stops.get(id);
  };

  const navigate = async (
    source: PrototypeStop,
    targetId: StopId,
    direction: 'back' | 'forward'
  ): Promise<void> => {
    const target = stops.get(targetId);
    if (target === undefined) {
      return;
    }
    if (direction === 'forward' && source.document !== target.document) {
      const choice = await vscode.window.showInformationMessage(
        `CodeAlongAI suggests ${target.title} in ${target.document}. Open it on the right while keeping the origin visible?`,
        { modal: true },
        'Open on right'
      );
      if (choice !== 'Open on right') {
        snapshot(`cancelled ${source.id} -> ${target.id}`);
        return;
      }
    }
    await activateStop(target.id, `${direction} ${source.id} -> ${target.id}`);
  };

  const back = async (thread: vscode.CommentThread | undefined): Promise<void> => {
    const source = stopForThread(thread);
    if (source?.back !== undefined) {
      await navigate(source, source.back, 'back');
    }
  };

  const next = async (thread: vscode.CommentThread | undefined): Promise<void> => {
    const source = stopForThread(thread);
    if (source?.next !== undefined) {
      await navigate(source, source.next, 'forward');
    }
  };

  const destinations = async (thread: vscode.CommentThread | undefined): Promise<void> => {
    const source = stopForThread(thread);
    if (source === undefined || source.destinations.length === 0) {
      return;
    }
    const picked = await vscode.window.showQuickPick(
      source.destinations.map((destination) => ({
        label: destination.id === source.next ? `$(arrow-right) ${destination.label}` : destination.label,
        description: destination.description,
        detail: `${liveStops.has(destination.id) ? 'Visited' : 'Not visited'} · ${destination.id}`,
        stopId: destination.id
      })),
      {
        title: `Destinations from ${source.title}`,
        placeHolder: 'Choose any outgoing destination; visited stops remain available'
      }
    );
    if (picked === undefined) {
      snapshot(`cancelled destinations from ${source.id}`);
      return;
    }
    await navigate(source, picked.stopId, 'forward');
  };

  const reply = (value: vscode.CommentReply): void => {
    const text = value.text.trim();
    if (text.length === 0) {
      return;
    }
    const stop = [...liveStops.values()].find((candidate) => candidate.thread === value.thread);
    if (stop === undefined) {
      return;
    }
    value.thread.comments = [
      ...value.thread.comments,
      comment(human, text, 'question'),
      comment(codeAlongAi, deterministicAnswer(stop.id, text), 'deterministic answer')
    ];
    value.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    snapshot(`answered ${stop.id}; attention unchanged`);
  };

  const registrations = [
    vscode.commands.registerCommand('codealongai.prototype.comments.start', start),
    vscode.commands.registerCommand('codealongai.prototype.comments.back', back),
    vscode.commands.registerCommand('codealongai.prototype.comments.next', next),
    vscode.commands.registerCommand('codealongai.prototype.comments.destinations', destinations),
    vscode.commands.registerCommand('codealongai.prototype.comments.reply', reply),
    vscode.commands.registerCommand('codealongai.prototype.comments.showState', () => {
      snapshot('show state');
      output.show(true);
    }),
    vscode.commands.registerCommand('codealongai.prototype.comments.reset', reset)
  ];

  const disposable = vscode.Disposable.from({ dispose: reset }, ...registrations, controller, output);
  context.subscriptions.push(disposable);
  return disposable;
}
