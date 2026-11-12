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


def _route_after_review(state: AgentState) -> str:
    review = state.get("review") or {}
    if review.get("needs_repair"):
        return "canvas_editor"
    return END


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
