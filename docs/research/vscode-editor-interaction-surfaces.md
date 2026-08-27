# Stable VS Code surfaces for editor-context questions

Research date: 2026-08-27. Sources are limited to current Microsoft/VS Code documentation, API declarations, and first-party samples.

## Conclusion

A stable third-party extension cannot create or extend an arbitrary interactive widget inside a text editor in the way VS Code owns the Peek/Go to References widget. The stable command `editor.action.peekLocations` accepts a source URI, position, locations, and navigation behavior; it exposes no custom content or input hook. VS Code also explicitly prevents extensions from accessing the workbench DOM. The conclusion that Peek itself is not extensible is therefore an **inference from the complete published command/API surface**, rather than an explicit sentence in the documentation. [Built-in commands](https://code.visualstudio.com/api/references/commands), [extension capability restrictions](https://code.visualstudio.com/api/extension-capabilities/overview)

The closest stable native primitive is a **Comment thread**. It is anchored to a document `Range`, can display explanation text as Markdown, and can expose the native reply editor. A contributed reply command receives `CommentReply.text`, so the extension can interpret a reply as a free-form question and append the answer to the same thread. [Comment API reference](https://code.visualstudio.com/api/references/vscode-api#CommentThread), [official Commenting API sample](https://github.com/microsoft/vscode-extension-samples/tree/main/comment-sample)

## Stable options

| Primitive | Editor context | Explanation | Free-form question | Fit and limit |
| --- | --- | --- | --- | --- |
| Peek / Go to Locations | Anchored at a source position | Only the standard location list and file previews | No | `editor.action.peekLocations` is callable, and a reference provider can contribute locations, but neither API admits arbitrary content or controls. Using virtual documents could make a preview contain an explanation, but that is an **inference/workaround** and still provides no input. [Commands](https://code.visualstudio.com/api/references/commands), [reference providers](https://code.visualstudio.com/api/language-extensions/programmatic-language-features#find-all-references-to-a-symbol) |
| Comment thread | Anchored to an exact document range and rendered in the text editor | `Comment.body` accepts `string` or `MarkdownString` | Yes, through the native reply editor and `CommentReply.text` | Best stable match. It carries review/comment semantics and also appears in the Comments panel. Stable API can set a thread expanded, but reliable programmatic reveal-and-focus is proposed-only. [API](https://code.visualstudio.com/api/references/vscode-api#CommentController), [sample implementation](https://github.com/microsoft/vscode-extension-samples/blob/main/comment-sample/src/extension.ts), [sample menus](https://github.com/microsoft/vscode-extension-samples/blob/main/comment-sample/package.json) |
| CodeLens | Associated with a single-line range and displayed between source lines | Short command title only | Not directly; its command can open another input surface | Good as a discoverable “Ask about this” trigger, not as the conversation UI. [CodeLens API](https://code.visualstudio.com/api/references/vscode-api#CodeLens), [language-feature guide](https://code.visualstudio.com/api/language-extensions/programmatic-language-features#codelens-show-actionable-context-information-within-source-code) |
| Webview view | Sidebar or panel remains alongside the text editor | Arbitrary HTML | Yes | Preserves visibility of the editor and can track the active URI/range, but is not line-anchored. It is the best fallback if the comment metaphor or layout is unacceptable. [Webview guide](https://code.visualstudio.com/api/extension-guides/webview), [views contribution](https://code.visualstudio.com/api/references/contribution-points#contributesviews) |
| Webview panel | Separate editor tab/column | Arbitrary HTML | Yes | Fully customizable, but the UI is a distinct editor rather than an inset in the source editor. VS Code recommends using webviews only when native APIs are inadequate. [Webview guide](https://code.visualstudio.com/api/extension-guides/webview), [webview UX guidance](https://code.visualstudio.com/api/ux-guidelines/webviews) |
| Chat participant | VS Code-owned Chat experience, not an extension-chosen source range | Streamed Markdown and other response parts | Yes | Stable and conversation-native, but responses render in VS Code Chat rather than an extension-owned line widget; the extension does not control editor anchoring or placement. [Chat Participant guide](https://code.visualstudio.com/api/extension-guides/ai/chat), [stable Chat API](https://code.visualstudio.com/api/references/vscode-api#chat) |
| Custom editor | Owns the resource's editor tab | Arbitrary webview UI | Yes | Replaces the normal text editor for matching resources and requires document/view lifecycle synchronization. Disproportionate for an explanation attached to ordinary code. [Custom Editor guide](https://code.visualstudio.com/api/extension-guides/custom-editors) |
| InputBox / Quick Pick | Window-level transient overlay, not line-anchored | Title, placeholder, validation, and (for Quick Pick) brief prompt/item detail | InputBox: yes; Quick Pick: primarily selection/filter input | Smallest implementation, especially when launched from a CodeLens or existing decoration command, but it separates the question from the explanation and disappears when dismissed. [Quick Input API](https://code.visualstudio.com/api/references/vscode-api#QuickInput), [Quick Pick UX](https://code.visualstudio.com/api/ux-guidelines/quick-picks) |

## Proposed-only APIs to avoid in a shipping design

- `window.createWebviewTextEditorInset(editor, line, height, options)` is almost exactly the missing arbitrary, editor-embedded webview, but it remains in `vscode.proposed.editorInsets.d.ts`. [Proposed `editorInsets`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.editorInsets.d.ts)
- `CommentThread2.reveal(..., { focus: CommentThreadFocus.Reply })` would reliably open a thread and focus its reply editor, but it remains in `vscode.proposed.commentReveal.d.ts`. [Proposed `commentReveal`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.commentReveal.d.ts)
- Reading the currently focused comment thread is also proposed (`CommentController.activeCommentThread`). [Proposed `activeComment`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.activeComment.d.ts)
- Rich inline question carousels, including a free-form question type, are additions in `vscode.proposed.chatParticipantAdditions.d.ts`, not part of the stable Chat response surface. [Proposed `chatParticipantAdditions`](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts)

Proposed APIs are unstable, available only in Insiders, and should not be used in Marketplace-published extensions. [Using Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)

## Recommended smallest prototype

Prototype one interaction with the stable Comments API, without changing the underlying product state model:

1. Reuse the existing editor cue/command as the trigger.
2. Create one `CommentController` and one thread at the cue's exact `Uri` and `Range`.
3. Put the explanation in the first comment as a `MarkdownString`; set `canReply = true` and `collapsibleState = Expanded`.
4. Contribute one command to `comments/commentThread/context`. VS Code passes it a `CommentReply`; send `reply.text` through the existing question/answer path, then append the question and response as comments.
5. Dispose or replace the thread when the interaction changes, is accepted/rejected, or the extension deactivates.

The first spike should answer only these UX uncertainties: whether VS Code opens the newly expanded thread visibly enough without the proposed reveal API; whether “comment/reply” chrome is acceptable for a teaching conversation; and whether thread layout leaves enough source visible. If any fails, keep the same trigger and state wiring but move the conversation into a sidebar/panel Webview view. That fallback sacrifices exact line anchoring while preserving the live editor beside a fully controlled input surface.
