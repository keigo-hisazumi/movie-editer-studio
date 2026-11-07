import pytest

from studio.api import Api, ApiError
from studio.server import local_port, venv_python


def test_api(serve):
    base, fake = serve
    api = Api(base + "/")
    assert api.alive()
    assert api.videos()[0]["name"] == "20261017"
    assert api.topic("20261017", 2)["edit"]["revision"] == 1
    assert api.url("/media/x/proxy.mp4") == base + "/media/x/proxy.mp4"
    saved = api.save("20261017", 2, 1, {"keeps": []})
    assert saved["revision"] == 2 and fake.saved[0]["base_revision"] == 1
    with pytest.raises(ApiError) as e:
        api.save("20261017", 2, 1, {"keeps": []})
    assert e.value.status == 409 and "版 2" in str(e.value)
    with pytest.raises(ApiError) as e:
        api.topic("nope", 1)
    assert e.value.status == 404


def test_not_running():
    api = Api("http://127.0.0.1:9")
    assert not api.alive()
    with pytest.raises(ApiError) as e:
        api.videos()
    assert e.value.status == 0 and "つながりません" in str(e.value)


def test_local_port(tmp_path):
    assert local_port("http://127.0.0.1:8765") == 8765
    assert local_port("http://localhost:9000/") == 9000
    assert local_port("http://mac.local:8765") is None  # ほかの PC の serve は起動しない
    assert venv_python(tmp_path).parent.parent == tmp_path / ".venv"


def test_self_check_plays_sample(qapp):
    from pathlib import Path

    from studio.selfcheck import run

    sample = Path(__file__).parent / "data" / "sample.mp4"
    assert run(["x", "--self-check", str(sample)]) == 0
