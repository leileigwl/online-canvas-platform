from __future__ import annotations

from typing import TypedDict

from langgraph.graph import END, START, StateGraph


class AgentState(TypedDict, total=False):
    run_id: str
    goal: str
    context_revision: int
    canvas_items: list[dict]
    references: list[dict]
    coordination: dict
    subtasks: list[dict]
    plans: dict[str, str]
    editor_outputs: dict[str, list[dict]]
    summary: str
    operations: list[dict]
    verifier_report: dict
    review: dict
    review_feedback: str
    attempt: int
    max_repair_rounds: int
    repair_history: list[dict]


class AutonomousAgentState(TypedDict, total=False):
    run_id: str
    goal: str
    step: int
    max_steps: int
    compaction_count: int
    loop_messages: list[dict]
    pending_action: dict
    operations: list[dict]
    verifier_report: dict
    repair_rounds_used: int
    repair_history: list[dict]
    summary: str
    reply: str
    done: bool
    steps_log: list[dict]


def _route_after_review(state: AgentState) -> str:
    review = state.get("review") or {}
    if review.get("needs_repair"):
        return "canvas_editor"
    return END


def _route_autonomous_lead(state: AutonomousAgentState) -> str:
    if state.get("done"):
        return END
    return "tool_executor"


def build_agent_graph(nodes: dict, checkpointer):
    graph = StateGraph(AgentState)
    for name in ("coordinator", "planner", "canvas_editor", "verifier", "reviewer"):
        graph.add_node(name, nodes[name])
    graph.add_edge(START, "coordinator")
    graph.add_edge("coordinator", "planner")
    graph.add_edge("planner", "canvas_editor")
    graph.add_edge("canvas_editor", "verifier")
    graph.add_edge("verifier", "reviewer")
    graph.add_conditional_edges(
        "reviewer",
        _route_after_review,
        {"canvas_editor": "canvas_editor", END: END},
    )
    return graph.compile(checkpointer=checkpointer)


def build_autonomous_graph(nodes: dict, checkpointer):
    graph = StateGraph(AutonomousAgentState)
    graph.add_node("lead_agent", nodes["lead_agent"])
    graph.add_node("tool_executor", nodes["tool_executor"])
    graph.add_edge(START, "lead_agent")
    graph.add_conditional_edges(
        "lead_agent",
        _route_autonomous_lead,
        {"tool_executor": "tool_executor", END: END},
    )
    graph.add_edge("tool_executor", "lead_agent")
    return graph.compile(checkpointer=checkpointer)
