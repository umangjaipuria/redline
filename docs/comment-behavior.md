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
36. When multiple comments relate to nearby text, the rail should pack them in order without hiding any card.
37. When the main document scrolls, the comment rail should scroll so comments for visible anchors become visible.
38. When an anchor leaves the document viewport, its comment may leave the visible rail area.
39. When an anchor enters the document viewport, its comment should be able to enter the visible rail area.
40. Manual scrolling in the comment rail should not scroll the main document.
41. Manual scrolling in the comment rail should not deactivate the active thread.
42. Manual scrolling in the comment rail should allow the user to inspect comments away from the active thread without late layout, repaint, or scheduled reveal work snapping the rail back.
43. After manually scrolling away from the active comment, an explicit anchor, comment, or previous/next navigation action should scroll the rail back to that comment.
44. Programmatic previous/next comment navigation should move the document and rail together without rail jumps or rail scroll-range changes.
45. Previous/next navigation should select the first comment when no comment is active.
46. Previous navigation should be disabled at the first comment.
47. Next navigation should be disabled at the last comment.
48. Previous/next navigation should ignore duplicate thread ids.
49. The comment count should reflect the number of open threads.
50. The rail should be hidden when there are no threads and no composer.
51. The rail should remain available while a composer is open.
52. On narrow screens, comments should flow normally rather than using desktop anchor alignment.
53. Selecting text should make a comment action available near the selection.
54. The comment action should stay attached to the selection while the document scrolls or reflows.
55. The comment action should hide when there is no valid selection.
56. The comment action should hide while the composer is open.
57. The keyboard shortcut for commenting should open the composer for the current selection.
58. The keyboard shortcut for commenting should not fire while the user is typing in a form field.
59. The composer should focus its text box when it opens.
60. The composer should submit on the standard keyboard submit shortcut.
61. The composer should close on Escape.
62. The composer should not submit an empty comment.
63. Opening the composer should reopen the comment rail if needed without scrolling the reviewed document away from the selected text.
64. The composer should appear in document order near the selected text, even after focus moves from the document to the composer.
65. A composer for a selection below existing comments should appear after those comments.
66. A composer for a selection above existing comments should appear before those comments.
67. A composer should appear before orphaned comments.
68. Posting a composer comment, including the first comment in a document, should close the composer, clear the selection, and keep the reviewed document at the current scroll position.
69. Cancelling a composer should close it without creating a thread.
70. Reply controls should activate the thread before opening or closing the reply box.
71. A reply box should focus its text box when it opens.
72. A reply box should submit on the standard keyboard submit shortcut.
73. A reply box should close on Escape.
74. A reply box should close when focus leaves it and it has no text.
75. A reply box should not submit an empty reply.
76. Posting a reply should append a message to the thread.
77. Posting a reply should close the reply box.
78. Editing controls should activate the thread before opening the edit box.
79. Only the current author should be offered edit controls for their most recent message.
80. An edit box should focus its text box when it opens.
81. An edit box should place the cursor at the end of the existing message.
82. An edit box should submit on the standard keyboard submit shortcut.
83. An edit box should close on Escape without saving.
84. An edit box should not save an empty message.
85. Saving an edit should update only that message body.
86. Deleting a reply should remove only that reply.
87. The original message of a thread should not be deletable as a reply.
88. Deleting a thread should remove the whole thread, including replies in the thread.
89. Deleting the last thread should remove the stored review state from the document.
90. Deleting a thread, including the last thread in a document, should remove its highlight from the document view without changing the reviewed document scroll position.
91. An anchor that still matches exactly should be shown as anchored.
92. An anchor that shifts because of edits elsewhere should remain anchored.
93. A lightly edited anchor should be able to heal to the edited text.
94. A healed anchor should retain the original selected text for auditability.
95. A moderately changed anchor should be marked as needing review.
96. A fully rewritten anchor region should be marked orphaned.
97. Orphaned comments should stay visible and actionable in the rail.
98. Needs-review comments should stay visible and actionable in the rail.
99. Orphaned comments should keep their last-known quote for context.
100. Needs-review comments should be visually distinguishable from ordinary anchored comments.
101. Orphaned comments should be visually distinguishable from ordinary anchored comments.
102. A user should be able to re-anchor an orphaned or needs-review thread to the current selection.
103. Re-anchoring should keep the existing thread and messages.
104. Re-anchoring should update only the thread's anchor information.
105. Re-anchoring to missing text should fail without changing the thread.
106. Re-anchoring to text that appears more than once should require the intended occurrence number.
107. Anchor status summaries should label every comment thread as anchored, needs-review, or orphaned.
108. Anchor status summaries should be filterable to a document text range when a thread has a current resolved range.
109. Threads without a usable anchor should be reported as orphaned.
110. Reconciliation should not change message bodies.
111. Reconciliation should be idempotent when the document text has not changed.
112. Reconciliation should be allowed to refresh anchor hints without changing the user-visible comment content.
113. A duplicate phrase introduced later should not steal an existing anchor from its original context.
114. Ambiguous highlights should not be painted on the wrong occurrence.
115. Highlight rendering should follow the current resolved anchor state on every load.
116. Highlight rendering should not require saved inline markup in the document body.
117. The active anchor highlight should be visually distinct.
118. The reviewed document should preserve author whitespace that affects visible content.
119. The reviewed document should preserve author content while blocking reviewed-file executable behavior.
120. The reviewed document should not run executable behavior from the reviewed file.
121. The reviewed document should not allow reviewed-file forms to submit.
122. Reviewed-file assets should load only through the document's allowed local asset path.
123. Malformed embedded review state should not prevent the document from being viewed.
124. Malformed embedded review state should show a warning.
125. Malformed embedded review state should not be overwritten by a new write.
126. Unsupported review state should be ignored rather than migrated silently.
127. Saving review state should replace existing review state rather than duplicate it.
128. Empty review state should remove the stored review state.
129. Stored review state should escape dangerous text so it cannot break out of storage.
130. Comment writes should be guarded against stale document versions.
131. A stale write should fail with the current document state available for reload.
132. Independent comment additions should merge rather than drop each other.
133. A comment write after an external document edit should preserve the external edit.
134. Reconciliation after an external document edit should keep existing threads.
135. Live clients should refresh when comments are created, replied to, edited, deleted, or re-anchored.
136. Live clients should refresh when the document changes on disk.
137. Live clients should tell the user when the document changed outside the review UI.
138. Live clients should tell the user when embedded review state could not be read.
139. Agent-created comments should use the agent author when one is supplied.
140. Agent-created comments should default to an agent author when no author is supplied.
141. Browser-created comments should default to a user author when no author is supplied.
142. Agent batch updates should apply as one atomic review-state update.
143. Agent batch updates may create comments, add replies, edit messages, delete replies, delete threads, and re-anchor threads.
144. Agent batch updates should not include or modify document content.
145. Agent reads should be able to list compact thread summaries without returning document content.
146. Agent reads should be able to fetch one full thread by id.
147. Agent reads for a missing thread should fail clearly.
148. Agent thread summaries should report each thread's current anchor state.
149. Agent thread summaries should support filtering by recent message time.
150. Comment operations for an unknown live document should fail with guidance to re-resolve the document.
151. Opening a file that is already open in a running review server should reuse that server.
152. The open-documents list should update when documents are opened or closed.
153. The document chooser should not auto-open a document unless a specific document is requested.
154. Cross-origin browser requests to the local review service should be rejected.
155. Unsupported file types should be rejected for review.
