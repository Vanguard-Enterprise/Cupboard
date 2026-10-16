"""Development-only SSH stream of the source-owned agent's real host readings."""
import importlib.util
import json
from pathlib import Path
import time

spec = importlib.util.spec_from_file_location("agent", Path(__file__).with_name("cupboard-agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
country = agent.CountryLookup()
network = agent.NetworkRates()
while True:
    report = agent.health()
    report.update(network.sample())
    report["geolocation"] = country.get()
    print(json.dumps(report), flush=True)
    time.sleep(30)
