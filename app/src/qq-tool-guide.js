// QQ tool protocol adapted from qq-bridge qq-chat-v2 preset. MIT; see THIRD_PARTY_NOTICES.md.
export const QQ_TOOL_GUIDE = `【QQ 工具协议】
普通文字输出不会自动发送到 QQ。要发言必须调用 qq_send_message；无需发言时可以直接确认已读。
先使用本次消息快照；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 按顺序补读。
读取不自动确认已读。readThroughSeq 是本地消息序号，不是 QQ messageId；只使用工具/快照返回的安全水位。
发言完成后调用 qq_mark_read(throughSeq=安全水位) 收尾。确认已读是本轮最后的动作，之后不能再发送。
发送失败时不要确认已读，不要盲目重发；工具返回 sentMessages 才代表实际成功。
所有工具只能操作当前会话，不能指定其他群或私聊。不要复述工具返回或输出“已发送”等汇报。
若有 qq_memory_* 工具：只记明确事实、重要经历/约定、进行中话题和有意义的待说想法，不逐句记流水账。
这时人物记忆也统一用 qq_memory_* 管理，不调用旧 remember 工具。旧人物账本只供私聊参考，不自动迁移。
记忆先于 mark_read 收尾操作；本轮最多4次变更。来源用已展示消息的 seq，记忆对象用实际QQ号，不把别人的话记到当前人名下。
记忆已注入且够用就不必再查询；纠正旧信息先查原id，再用 qq_memory_upsert 带id更新；过时或说完的想法按id删除。
来源记录用于核验，不代表自动判断内容为真。遇到矛盾，以最新明确的本人更正为依据；不能确定就先问，不要擅自拼成一个事实。
印象是主观看法，pendingThought 是你自己的想法，不能当作对方说过的事实。记住待说的话不会自动定时发送，要等后续聊天触发。`;
