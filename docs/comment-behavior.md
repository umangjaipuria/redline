# Comment Behavior

1. A comment thread should normally be anchored to selected document text.
2. A thread without a usable anchor should be treated as unanchored or orphaned, not as a separate comment type.
3. Creating a comment from a browser selection should capture the selected quote, nearby text before it, nearby text after it, and approximate start and end positions in the document text.
4. Creating a comment from an agent-supplied quote should use that quote to capture the same anchor information before saving the thread.
5. If an agent-supplied quote appears more than once, the request should include the intended occurrence number.
6. Occurrence numbers should be used only to choose an instance at creation time and should not become the saved anchor.
7. Creating a comment on missing text should fail without creating a thread.
8. Creating a comment without selected or quoted text should fail without creating a thread.
9. Creating a comment with an empty body should fail without creating a thread.
10. Creating a new comment should add a new thread with one original message.
11. Creating a new comment should activate the new thread.
12. Creating a new comment should reveal the new thread in the comment rail.
13. Creating, editing, replying, deleting, or re-anchoring comments should not rewrite document body content.
14. Comment state should survive normal document content edits.
15. Comment state should be isolated per document.
16. Opening the same document more than once should reuse the same live review session.
17. Closing a document should remove its live review session without affecting other open documents.
18. Clicking a document anchor should make its corresponding comment active and scroll the comment rail to that comment if it is not already visible.
19. Clicking a comment should make its corresponding document anchor active and scroll the main document to that anchor if it is not already visible.
20. Only one thread should be active at a time.
21. Clicking empty document space should clear the active thread.
22. Clicking empty comment rail space should clear the active thread.
23. Clicking inside reply, edit, delete, or re-anchor controls should not accidentally clear the active thread.
24. Clicking an already-active document anchor should still reveal the matching comment in the comment rail.
25. Clicking an already-active comment should still keep the matching document anchor visible.
26. If the comment rail is collapsed, selecting an anchor or comment that needs the rail should reopen it.
27. The rail collapsed/open setting should persist across reloads.
28. The current author name should persist across reloads.
29. Anchored comments should be ordered by their anchor order in the document.
30. Unanchored or orphaned comments should appear after anchored comments.
31. If two comments cannot be separated by anchor position, they should appear in creation order.
32. Comment cards should align near their document anchors when there is enough screen width.
33. Comment cards should not overlap each other.
34. Comment cards should never be placed above the reachable start of the comment rail.
35. Comment cards should remain reachable by scrolling the comment rail.
36. When multiple comments relate to nearby text, the rail should pack them in document order without overlap, even if that makes the rail stack taller than the matching document region.
37. During document-driven scrolling, the rail should choose one visible sync anchor: the active visible thread if there is one, otherwise the visible anchor closest to the document viewport center.
38. During document-driven scrolling, the chosen sync anchor's card should keep the same viewport-top relationship as its document anchor whenever the rail scroll range allows it.
39. During document-driven scrolling in dense comment regions, surrounding packed cards may be offset from their exact anchors, but they should remain ordered, reachable, and not cause the chosen sync card to disappear.
40. Clicking a document anchor should activate that thread and reveal its rail card; if the card is already partly visible, the rail should scroll only the minimum amount needed to make the card visible rather than re-centering it.
41. Clicking a comment card should activate that thread and scroll the document to the anchor; after the document scroll settles, the rail card should remain visible and should not snap back to a half-visible or hidden position.
42. When an anchor leaves the document viewport, its comment may leave the visible rail area.
43. When an anchor enters the document viewport, its comment should be able to enter the visible rail area.
44. Manual scrolling in the comment rail should not scroll the main document.
45. Manual scrolling in the comment rail should not deactivate the active thread.
46. Manual scrolling in the comment rail should allow the user to inspect comments away from the active thread without late layout, repaint, or scheduled reveal work snapping the rail back.
47. After manual rail scrolling, the rail may remain decoupled from document position until the user scrolls the document or explicitly activates an anchor, comment, or previous/next navigation target.
48. When the user scrolls the document after manual rail scrolling, document-driven sync should resume using the visible sync-anchor rule above, not by blindly copying document scrollTop into the rail.
49. Programmatic previous/next comment navigation should move the document and rail together without rail jumps or rail scroll-range changes.
50. Previous/next navigation should select the first comment when no comment is active.
51. Previous navigation should be disabled at the first comment.
52. Next navigation should be disabled at the last comment.
53. Previous/next navigation should ignore duplicate thread ids.
54. The comment count should reflect the number of open threads.
55. The rail should be hidden when there are no threads and no composer.
56. The rail should remain available while a composer is open.
57. On narrow screens, comments should flow normally rather than using desktop anchor alignment.
58. Selecting text should make a comment action available near the selection.
59. The comment action should stay attached to the selection while the document scrolls or reflows.
60. The comment action should hide when there is no valid selection.
61. The comment action should hide while the composer is open.
62. The keyboard shortcut for commenting should open the composer for the current selection.
63. The keyboard shortcut for commenting should not fire while the user is typing in a form field.
64. The composer should focus its text box when it opens.
65. The composer should submit on the standard keyboard submit shortcut.
66. The composer should close on Escape.
67. The composer should not submit an empty comment.
68. Opening the composer should reopen the comment rail if needed without scrolling the reviewed document away from the selected text.
69. The composer should appear in document order near the selected text, even after focus moves from the document to the composer.
70. A composer for a selection below existing comments should appear after those comments.
71. A composer for a selection above existing comments should appear before those comments.
72. A composer should appear before orphaned comments.
73. Posting a composer comment, including the first comment in a document, should close the composer, clear the selection, and keep the reviewed document at the current scroll position.
74. Cancelling a composer should close it without creating a thread.
75. Reply controls should activate the thread before opening or closing the reply box.
76. A reply box should focus its text box when it opens.
77. A reply box should submit on the standard keyboard submit shortcut.
78. A reply box should close on Escape.
79. A reply box should close when focus leaves it and it has no text.
80. A reply box should not submit an empty reply.
81. Posting a reply should append a message to the thread.
82. Posting a reply should close the reply box.
83. Editing controls should activate the thread before opening the edit box.
84. Only the current author should be offered edit controls for their most recent message.
85. An edit box should focus its text box when it opens.
86. An edit box should place the cursor at the end of the existing message.
87. An edit box should submit on the standard keyboard submit shortcut.
88. An edit box should close on Escape without saving.
89. An edit box should not save an empty message.
90. Saving an edit should update only that message body.
91. Deleting a reply should remove only that reply.
92. The original message of a thread should not be deletable as a reply.
93. Deleting a thread should remove the whole thread, including replies in the thread.
94. Deleting the last thread should remove the stored review state from the document.
95. Deleting a thread, including the last thread in a document, should remove its highlight from the document view without changing the reviewed document scroll position.
96. An anchor that still matches exactly should be shown as anchored.
97. An anchor that shifts because of edits elsewhere should remain anchored.
98. A lightly edited anchor should be able to heal to the edited text.
99. A healed anchor should retain the original selected text for auditability.
100. A moderately changed anchor should be marked as needing review.
101. A fully rewritten anchor region should be marked orphaned.
102. Orphaned comments should stay visible and actionable in the rail.
103. Needs-review comments should stay visible and actionable in the rail.
104. Orphaned comments should keep their last-known quote for context.
105. Needs-review comments should be visually distinguishable from ordinary anchored comments.
106. Orphaned comments should be visually distinguishable from ordinary anchored comments.
107. A user should be able to re-anchor an orphaned or needs-review thread to the current selection.
108. Re-anchoring should keep the existing thread and messages.
109. Re-anchoring should update only the thread's anchor information.
110. Re-anchoring to missing text should fail without changing the thread.
111. Re-anchoring to text that appears more than once should require the intended occurrence number.
112. Anchor status summaries should label every comment thread as anchored, needs-review, or orphaned.
113. Anchor status summaries should be filterable to a document text range when a thread has a current resolved range.
114. Threads without a usable anchor should be reported as orphaned.
115. Reconciliation should not change message bodies.
116. Reconciliation should be idempotent when the document text has not changed.
117. Reconciliation should be allowed to refresh anchor hints without changing the user-visible comment content.
118. A duplicate phrase introduced later should not steal an existing anchor from its original context.
119. Ambiguous highlights should not be painted on the wrong occurrence.
120. Highlight rendering should follow the current resolved anchor state on every load.
121. Highlight rendering should not require saved inline markup in the document body.
122. The active anchor highlight should be visually distinct.
123. The reviewed document should preserve author whitespace that affects visible content.
124. The reviewed document should preserve author content while blocking reviewed-file executable behavior.
125. The reviewed document should not run executable behavior from the reviewed file.
126. The reviewed document should not allow reviewed-file forms to submit.
127. Reviewed-file assets should load only through the document's allowed local asset path.
128. Malformed embedded review state should not prevent the document from being viewed.
129. Malformed embedded review state should show a warning.
130. Malformed embedded review state should not be overwritten by a new write.
131. Unsupported review state should be ignored rather than migrated silently.
132. Saving review state should replace existing review state rather than duplicate it.
133. Empty review state should remove the stored review state.
134. Stored review state should escape dangerous text so it cannot break out of storage.
135. Comment writes should be guarded against stale document versions.
136. A stale write should fail with the current document state available for reload.
137. Independent comment additions should merge rather than drop each other.
138. A comment write after an external document edit should preserve the external edit.
139. Reconciliation after an external document edit should keep existing threads.
140. Live clients should refresh when comments are created, replied to, edited, deleted, or re-anchored.
141. Live clients should refresh when the document changes on disk.
142. Live clients should tell the user when the document changed outside the review UI.
143. Live clients should tell the user when embedded review state could not be read.
144. Agent-created comments should use the agent author when one is supplied.
145. Agent-created comments should default to an agent author when no author is supplied.
146. Browser-created comments should default to a user author when no author is supplied.
147. Agent batch updates should apply as one atomic review-state update.
148. Agent batch updates may create comments, add replies, edit messages, delete replies, delete threads, and re-anchor threads.
149. Agent batch updates should not include or modify document content.
150. Agent reads should be able to list compact thread summaries without returning document content.
151. Agent reads should be able to fetch one full thread by id.
152. Agent reads for a missing thread should fail clearly.
153. Agent thread summaries should report each thread's current anchor state.
154. Agent thread summaries should support filtering by recent message time.
155. Comment operations for an unknown live document should fail with guidance to re-resolve the document.
156. Opening a file that is already open in a running review server should reuse that server.
157. The open-documents list should update when documents are opened or closed.
158. The document chooser should not auto-open a document unless a specific document is requested.
159. Cross-origin browser requests to the local review service should be rejected.
160. Unsupported file types should be rejected for review.
