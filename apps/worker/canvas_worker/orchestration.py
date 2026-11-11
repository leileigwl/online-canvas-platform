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
    review: dict


def build_agent_graph(nodes: dict, checkpointer):
    graph = StateGraph(AgentState)
    for name in ("coordinator", "planner", "canvas_editor", "reviewer"):
        graph.add_node(name, nodes[name])
    graph.add_edge(START, "coordinator")
    graph.add_edge("coordinator", "planner")
    graph.add_edge("planner", "canvas_editor")
    graph.add_edge("canvas_editor", "reviewer")
    graph.add_edge("reviewer", END)
    return graph.compile(checkpointer=checkpointer)
