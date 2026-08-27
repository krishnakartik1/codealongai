// PROTOTYPE ONLY: validates native VS Code Comment-thread interaction in a real
// Extension Development Host. This file is intentionally disposable.
import * as vscode from 'vscode';

const controllerId = 'codealongai.prototype.nativeComments';

type StopId = 'checkout-origin' | 'pricing-follow';

interface PrototypeStop {
  id: StopId;
  document: 'checkout.ts' | 'pricing.ts';
  anchor: string;
  explanation: string;
}

interface LiveStop extends PrototypeStop {
  thread: vscode.CommentThread;
}

const checkoutStop: PrototypeStop = {
  id: 'checkout-origin',
  document: 'checkout.ts',
  anchor: 'subtotal(cart)',
  explanation: [
    '**Walkthrough stop 1 of 2**',
    '',
    '`checkout.ts` asks `subtotal` to summarize the cart before displaying it.',
    '',
    'Ask a question in the native reply box below. When you are ready, run **CodeAlongAI Prototype: Follow to pricing stop**.'
  ].join('\n')
};

const pricingStop: PrototypeStop = {
  id: 'pricing-follow',
  document: 'pricing.ts',
  anchor: 'total - price',
  explanation: [
    '**Walkthrough stop 2 of 2**',
    '',
    'The reducer subtracts each price from an accumulator that starts at zero, so a positive cart produces a negative subtotal.',
    '',
    'This is explanation-only: the prototype never edits the workspace.'
  ].join('\n')
};

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
  if (stop === 'checkout-origin') {
    if (normalized.includes('where') || normalized.includes('subtotal') || normalized.includes('pricing')) {
      return '`subtotal` is defined in `pricing.ts`. Use **Follow to pricing stop** when you want to inspect that definition while keeping this origin visible.';
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
  let currentStop: StopId | undefined;

  const snapshot = (action: string): void => {
    const state = {
      action,
      currentStop,
      stops: [...liveStops.values()].map((stop) => ({
        id: stop.id,
        document: stop.document,
        commentCount: stop.thread.comments.length,
        collapsibleState: stop.thread.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded
          ? 'expanded'
          : 'collapsed',
        canReply: stop.thread.canReply === true
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

  const ensureStop = async (
    stop: PrototypeStop,
    column: vscode.ViewColumn
  ): Promise<LiveStop> => {
    const existing = liveStops.get(stop.id);
    if (existing !== undefined) {
      existing.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      await vscode.window.showTextDocument(existing.thread.uri, { viewColumn: column, preserveFocus: false });
      currentStop = stop.id;
      snapshot(`reopened ${stop.id}`);
      return existing;
    }

    const document = await workspaceDocument(stop.document);
    await vscode.window.showTextDocument(document, { viewColumn: column, preserveFocus: false });
    const thread = controller.createCommentThread(
      document.uri,
      rangeFor(document, stop.anchor),
      [comment(codeAlongAi, new vscode.MarkdownString(stop.explanation), 'walkthrough')]
    );
    thread.label = `CodeAlongAI · ${stop.document}`;
    thread.contextValue = 'codealongaiWalkthrough';
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    const live = { ...stop, thread };
    liveStops.set(stop.id, live);
    currentStop = stop.id;
    snapshot(`created ${stop.id}`);
    return live;
  };

  const reset = (): void => {
    for (const stop of liveStops.values()) {
      stop.thread.dispose();
    }
    liveStops.clear();
    currentStop = undefined;
    snapshot('reset');
  };

  const start = async (): Promise<void> => {
    reset();
    await ensureStop(checkoutStop, vscode.ViewColumn.One);
    output.show(true);
  };

  const follow = async (): Promise<void> => {
    if (!liveStops.has('checkout-origin')) {
      await start();
    }
    const choice = await vscode.window.showInformationMessage(
      'CodeAlongAI suggests pricing.ts. Open it on the right while keeping checkout.ts visible?',
      { modal: true },
      'Open on right'
    );
    if (choice !== 'Open on right') {
      snapshot('declined pricing-follow');
      return;
    }
    const origin = liveStops.get('checkout-origin');
    if (origin !== undefined) {
      origin.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
    await ensureStop(pricingStop, vscode.ViewColumn.Beside);
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
    currentStop = stop.id;
    snapshot(`answered ${stop.id}`);
  };

  const registrations = [
    vscode.commands.registerCommand('codealongai.prototype.comments.start', start),
    vscode.commands.registerCommand('codealongai.prototype.comments.follow', follow),
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
