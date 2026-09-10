"""Text-fast-path routing (ticket G4)."""

from __future__ import annotations

from mantri.router import Path, RouterConfig, choose_route, escalate

from .mantri_fakes import ssg

CONFIG = RouterConfig(vision_model="vl-model", text_model="text-model")


def test_a_complete_dom_screen_takes_the_text_path() -> None:
    route = choose_route(ssg(), config=CONFIG)
    assert route.path is Path.TEXT_FAST
    assert route.model == "text-model"
    assert route.attach_image is False
    assert route.request_visual is False


def test_an_attached_screenshot_is_never_downgraded() -> None:
    """The client already paid to capture, redact and send it.

    Routing an attached image to a text model would answer from exactly the
    description the client had judged insufficient - and would silently discard bytes
    that cost a capture, a redaction pass and an egress-guard verification.
    """
    route = choose_route(ssg(), has_image=True, config=CONFIG)
    assert route.path is Path.VISION
    assert route.attach_image is True
    assert route.request_visual is False


def test_canvas_apps_go_to_vision_and_ask_for_a_screenshot() -> None:
    screen = ssg(page={"origin_class": "gov.in", "page_type": "canvas_app", "sensitivity": "private"})
    route = choose_route(screen, config=CONFIG)
    assert route.path is Path.VISION
    assert route.request_visual is True
    assert "canvas_app" in route.reason


def test_low_coverage_forces_vision() -> None:
    screen = ssg()
    screen["redaction_manifest"]["coverage_confidence"] = 0.4
    route = choose_route(screen, config=CONFIG)
    assert route.path is Path.VISION
    assert "coverage_confidence" in route.reason


def test_high_unexplained_ratio_forces_vision() -> None:
    screen = ssg()
    screen["redaction_manifest"]["unexplained_pixel_ratio"] = 0.5
    assert choose_route(screen, config=CONFIG).path is Path.VISION


def test_missing_coverage_does_not_buy_the_cheap_path() -> None:
    """Absent is not the same as high.

    A malformed manifest must not be able to purchase the fast path by omitting the
    number that would have disqualified it.
    """
    screen = ssg()
    del screen["redaction_manifest"]["coverage_confidence"]
    route = choose_route(screen, config=CONFIG)
    assert route.path is Path.VISION
    assert "absent" in route.reason


def test_two_stalled_steps_force_vision() -> None:
    screen = ssg(
        history=[
            {"step": 0, "action": "click", "target": "e2", "outcome": "no_change"},
            {"step": 1, "action": "click", "target": "e2", "outcome": "no_change"},
        ]
    )
    assert choose_route(screen, config=CONFIG).path is Path.VISION


def test_a_recovered_task_is_not_stalled() -> None:
    """Consecutive, not cumulative - otherwise every long task ends up on vision."""
    screen = ssg(
        history=[
            {"step": 0, "action": "click", "outcome": "no_change"},
            {"step": 1, "action": "click", "outcome": "advanced"},
        ]
    )
    assert choose_route(screen, config=CONFIG).path is Path.TEXT_FAST


def test_tier_two_from_the_client_is_honoured() -> None:
    assert choose_route(ssg(tier=2), config=CONFIG).path is Path.VISION


def test_text_model_falls_back_to_the_configured_model() -> None:
    """One configured endpoint must keep working, just without the saving."""
    config = RouterConfig(vision_model="only-model", text_model="")
    assert choose_route(ssg(), config=config).model == "only-model"


def test_escalation_moves_a_text_route_to_vision() -> None:
    route = choose_route(ssg(), config=CONFIG)
    escalated = escalate(route, "target did not exist", config=CONFIG)
    assert escalated.path is Path.VISION
    assert escalated.request_visual is True
    assert "target did not exist" in escalated.reason


def test_escalating_a_vision_route_is_a_no_op() -> None:
    route = choose_route(ssg(tier=2), has_image=True, config=CONFIG)
    assert escalate(route, "why", config=CONFIG) is route


def test_routing_is_pure() -> None:
    screen = ssg()
    before = dict(screen)
    choose_route(screen, config=CONFIG)
    assert screen == before
