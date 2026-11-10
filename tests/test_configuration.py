import pytest
from backend.database import configuration


def test_database_secret_file_is_explicit_and_not_silent_sqlite(tmp_path, monkeypatch):
    monkeypatch.delenv('CLASS_ENV',raising=False)
    monkeypatch.delenv('CLASS_DATABASE_URL',raising=False)
    monkeypatch.setenv('CLASS_DATA_DIR',str(tmp_path/'runtime'))
    secret=tmp_path/'connection'
    secret.write_text('mysql+pymysql://test:fake@db/class_test\n',encoding='utf-8')
    monkeypatch.setenv('CLASS_DATABASE_URL_FILE',str(secret))
    _,url=configuration()
    assert url=='mysql+pymysql://test:fake@db/class_test'
    secret.write_text('',encoding='utf-8')
    with pytest.raises(ValueError,match='empty'):
        configuration()
    monkeypatch.setenv('CLASS_DATABASE_URL','sqlite:///should-not-win.db')
    with pytest.raises(ValueError,match='not both'):
        configuration()


def test_production_rejects_data_directory_outside_project(tmp_path,monkeypatch):
    monkeypatch.setenv('CLASS_ENV','production')
    monkeypatch.setenv('CLASS_DATA_DIR',str(tmp_path))
    with pytest.raises(ValueError,match='must stay under'):
        configuration()
