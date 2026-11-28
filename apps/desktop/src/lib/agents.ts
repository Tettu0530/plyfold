// What an agent's CLI cannot do over ACP, known by the agent's id (the engine learns it from the agent at connect time
// and refuses with an error; this only keeps the buttons that would lead there out of sight)

/** Agents that do not advertise `session/fork`: no side chat, and no continuing a conversation as a copy */
const NO_FORK = new Set(["gemini", "antigravity-acp"]);
/** Agents that do not advertise `session/list`: their own conversations cannot be listed */
const NO_LIST = new Set(["gemini"]);

export const canFork = (agent: string | undefined) => !agent || !NO_FORK.has(agent);
export const canList = (agent: string | undefined) => !agent || !NO_LIST.has(agent);
