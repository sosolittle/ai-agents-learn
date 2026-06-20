After building a multi-agent flow, I noticed another mistake: not every request deserves the full workflow.

My last post was about separating agents into planner, worker, and reviewer. That fixed one problem. It also exposed the next one.

If every request runs through the full agent stack, the system gets slower, more expensive, and harder to debug. In a naive setup, a user asking "what's an API?" can end up going through the same path as "create an MVP plan" or "refund this customer." Same machinery. Wildly different cost and risk.

The fix wasn't more agents. It was a router in front of them.

The router is the first real boundary. Before any tool runs, before any loop spins up, before any agent gets involved, one cheap call decides the smallest safe path:

- Direct answer — just respond, no tools
- Tool use — one backend call
- Research — go gather external sources
- Multi-agent workflow — planner → worker → reviewer
- Human approval — pause, this is irreversible
- Refusal — block it, it's unsafe

The thing that took me a while to internalize: routing is not about making the system smarter. It's about making the system controlled.

A smarter system tries to handle everything. A controlled system knows what to handle, what to escalate, and what to refuse. The router is where that line gets drawn — and it's where human approval stops being an afterthought and becomes an actual route a request can take.

Before asking how many agents a system needs, I now ask a cheaper question first: should this request even reach an agent?

Code's in the repo (module 10), same as the rest of the series.

#AIEngineering #LLM #AgentsInProduction #SoftwareEngineering #AI
