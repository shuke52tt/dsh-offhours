import sys
sys.path.insert(0, sys.argv[1])
import superagent_bridge as b

assert b.ticket_status({"state": "open", "stage": "working"}) == ("in_progress", "working")
assert b.ticket_status({"state": "open", "stage": "person", "attention": {"question": "x"}}) == ("review", "attention")
assert b.ticket_status({"state": "ended", "ended": {"outcome": "merged"}}) == ("done", "ticket-ended")
assert b.ticket_status({"state": "ended", "ended": {"outcome": "stopped"}}) == ("review", "ticket-ended")
print("ticket-status PASS")
