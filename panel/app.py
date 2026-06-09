import streamlit as st
import requests
import json
import pandas as pd
import numpy as np
from datetime import datetime, timezone
import tempfile
import os
import time

st.set_page_config(
    page_title="Log Alert - 规则调试面板",
    page_icon="🔔",
    layout="wide",
    initial_sidebar_state="expanded"
)

st.title("🔔 日志告警规则调试面板")

API_BASE = os.environ.get("LOG_ALERT_API", "http://localhost:3000")

with st.sidebar:
    st.header("⚙️ 配置")
    api_url = st.text_input("API 地址", API_BASE)
    st.divider()

    st.header("📂 输入文件")
    log_file = st.file_uploader("上传历史日志文件", type=["log", "txt", "json"])
    rules_file = st.file_uploader("上传规则配置文件(YAML)", type=["yaml", "yml"])
    st.divider()

    st.header("📊 解析配置")
    log_format = st.selectbox(
        "日志格式",
        ["auto", "nginx", "apache", "syslog", "json", "grok", "regex"],
        index=0
    )

    if log_format == "grok":
        grok_pattern = st.text_area("Grok模式", value="%{IPORHOST:clientip} - %{USER:remote_user} \\[%{HTTPDATE:timestamp}\\] \"%{WORD:method} %{URIPATHPARAM:path} HTTP/%{NUMBER:http_version}\" %{NUMBER:status} %{NUMBER:body_bytes_sent}")
    elif log_format == "regex":
        regex_pattern = st.text_area("正则表达式(命名捕获组)", value="(?P<ip>\\d+\\.\\d+\\.\\d+\\.\\d+) - (?P<user>\\S+) \\[(?P<time>[^\\]]+)\\] \"(?P<method>\\S+) (?P<path>\\S+) (?P<proto>[^\"]+)\" (?P<status>\\d+) (?P<size>\\d+)")
    else:
        grok_pattern = None
        regex_pattern = None

    source_name = st.text_input("来源标识", value="test")
    timezone = st.selectbox("时区", ["UTC", "Asia/Shanghai", "America/New_York", "Europe/London"], index=0)
    st.divider()

    st.header("🎯 规则参数调整")
    st.caption("调整规则参数观察命中变化(需要先运行测试)")

    test_threshold = st.slider("告警阈值(条数)", 1, 1000, 50, 5)
    test_window = st.slider("时间窗口(秒)", 10, 3600, 300, 10)
    test_slide = st.slider("滑动步长(秒)", 1, 600, 10, 1)
    st.divider()

    run_test = st.button("🚀 运行测试", type="primary", use_container_width=True)

tab1, tab2, tab3, tab4 = st.tabs(["📊 命中分析", "📈 时间线图表", "📋 规则详情", "🔍 日志解析预览"])


def check_api():
    try:
        resp = requests.get(f"{api_url}/health", timeout=3)
        return resp.status_code == 200, resp.json() if resp.status_code == 200 else None
    except Exception as e:
        return False, str(e)


def parse_log_content(file_content, parser_config):
    lines = [l for l in file_content.decode("utf-8").split("\n") if l.strip()]
    try:
        resp = requests.post(
            f"{api_url}/api/v1/test/parse",
            json={
                "lines": lines[:1000],
                "parser_config": parser_config,
                "source": source_name
            },
            timeout=30
        )
        if resp.status_code == 200:
            return resp.json()
        return None
    except Exception as e:
        st.error(f"解析请求失败: {e}")
        return None


def test_rules(file_content, parser_config, rules_content):
    lines = [l for l in file_content.decode("utf-8").split("\n") if l.strip()]
    try:
        import yaml
        rules_data = yaml.safe_load(rules_content.decode("utf-8"))
        if isinstance(rules_data, dict) and "rules" in rules_data:
            rules_data = rules_data["rules"]
        if not isinstance(rules_data, list):
            rules_data = [rules_data]
    except Exception as e:
        st.error(f"规则文件解析失败: {e}")
        return None

    try:
        resp = requests.post(
            f"{api_url}/api/v1/test/rules",
            json={
                "lines": lines[:5000],
                "parser_config": parser_config,
                "rules": rules_data,
                "source": source_name
            },
            timeout=60
        )
        if resp.status_code == 200:
            return resp.json()
        st.error(f"测试失败: {resp.status_code} {resp.text}")
        return None
    except Exception as e:
        st.error(f"规则测试请求失败: {e}")
        return None


def infer_format(file_content):
    lines = [l for l in file_content.decode("utf-8").split("\n") if l.strip()]
    if len(lines) < 10:
        return None
    try:
        resp = requests.post(
            f"{api_url}/api/v1/infer",
            json={"lines": lines[:100], "max_suggestions": 5},
            timeout=30
        )
        if resp.status_code == 200:
            return resp.json()
        return None
    except Exception as e:
        st.warning(f"自动推断请求失败: {e}")
        return None


api_ok, api_info = check_api()
if not api_ok:
    st.error(f"❌ 无法连接到API服务: {api_info}")
    st.info("请确保 log-alert API 服务已启动: `log-alert serve`")
    st.stop()
else:
    with st.sidebar:
        st.success(f"✅ API连接正常")
        with st.expander("服务状态"):
            st.json(api_info)

if run_test and (not log_file or not rules_file):
    st.error("请先上传日志文件和规则配置文件!")

if log_file:
    file_content = log_file.read()
    parser_config = {}

    if log_format == "auto":
        with st.spinner("正在自动推断日志格式..."):
            infer_result = infer_format(file_content)
            if infer_result:
                with tab4:
                    st.subheader("🤖 自动格式推断结果")
                    if infer_result.get("suggestions"):
                        for i, s in enumerate(infer_result["suggestions"]):
                            rate = f"{s['matchRate']*100:.1f}%"
                            st.markdown(f"**#{i+1} {s['name']}** - 匹配率: `{rate}`")
                            with st.expander(f"模式详情"):
                                st.code(s["pattern"])
                                if s.get("sampleMatches"):
                                    st.caption("示例匹配:")
                                    for sm in s["sampleMatches"][:2]:
                                        st.json(sm["match"])
                    if infer_result.get("autoGeneratedPattern"):
                        st.markdown(f"**自动生成草稿模式** (匹配率: {infer_result.get('autoGeneratedMatchRate', 0)*100:.1f}%)")
                        st.code(infer_result["autoGeneratedPattern"])
                        if st.button("使用此模式", key="use_auto"):
                            parser_config = {"format": "grok", "grok_pattern": infer_result["autoGeneratedPattern"]}

    if not parser_config:
        if log_format == "auto":
            lines = [l for l in file_content.decode("utf-8").split("\n") if l.strip()]
            first_lines = "".join(lines[:3])
            if "{" in first_lines[:50] and '"' in first_lines:
                parser_config = {"format": "json"}
            elif any(k in first_lines for k in ["GET", "POST", "PUT", "DELETE"]):
                parser_config = {"format": "nginx"}
            else:
                parser_config = {"format": "syslog"}
        elif log_format == "grok":
            parser_config = {"format": "grok", "grok_pattern": grok_pattern}
        elif log_format == "regex":
            parser_config = {"format": "regex", "regex_pattern": regex_pattern}
        else:
            parser_config = {"format": log_format}

    parser_config["source"] = source_name

    with tab4:
        st.subheader("📋 日志解析预览")
        with st.spinner("解析日志..."):
            parse_result = parse_log_content(file_content, parser_config)

        if parse_result:
            col1, col2, col3 = st.columns(3)
            col1.metric("总行数", parse_result["total"])
            col2.metric("成功解析", parse_result["parsed_count"],
                       delta=f"{parse_result['parse_rate']*100:.1f}%")
            col3.metric("解析失败", parse_result["total"] - parse_result["parsed_count"])

            if parse_result.get("results"):
                parsed_logs = []
                for r in parse_result["results"]:
                    if r.get("success") and r.get("log"):
                        log = r["log"]
                        entry = {
                            "时间": datetime.fromtimestamp(log["timestamp"]/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                            "级别": log["level"],
                            "来源": log["source"],
                            "消息": log["message"][:100] + ("..." if len(log["message"]) > 100 else "")
                        }
                        if log.get("fields"):
                            for k, v in list(log["fields"].items())[:8]:
                                if not any(x in k.lower() for x in ["message", "timestamp"]):
                                    entry[k] = str(v)[:50]
                        parsed_logs.append(entry)

                if parsed_logs:
                    st.dataframe(pd.DataFrame(parsed_logs).head(50), use_container_width=True)

            if parse_result.get("errors"):
                with st.expander(f"⚠️ 解析错误 ({len(parse_result['errors'])}条)"):
                    for e in parse_result["errors"][:20]:
                        st.warning(f"{e.get('error')}: {e.get('line', '')[:100]}")

if run_test and log_file and rules_file:
    file_content = log_file.read()
    rules_content = rules_file.read()

    with st.spinner("正在运行规则测试..."):
        result = test_rules(file_content, parser_config, rules_content)

    if result:
        with tab1:
            st.subheader("🎯 规则命中分析")
            summary = result.get("summary", {})
            c1, c2, c3, c4 = st.columns(4)
            c1.metric("总日志行", summary.get("total_lines", 0))
            c2.metric("解析成功", summary.get("parsed_lines", 0),
                     delta=f"{summary.get('parse_rate', 0)*100:.1f}%")
            c3.metric("告警总数", summary.get("total_alerts", 0))
            c4.metric("评估规则", summary.get("rules_evaluated", 0))

            st.divider()
            st.subheader("各规则命中统计")

            rule_hits = result.get("rule_hits", [])
            if rule_hits:
                df_hits = pd.DataFrame([
                    {
                        "规则名称": rh.get("rule_name", ""),
                        "规则ID": rh.get("rule_id", ""),
                        "命中次数": rh.get("count", 0),
                    }
                    for rh in rule_hits
                ])
                st.dataframe(df_hits, use_container_width=True, hide_index=True)

                for rh in rule_hits:
                    if rh.get("count", 0) > 0:
                        with st.expander(f"🔍 {rh.get('rule_name')} ({rh.get('count')}次命中)"):
                            st.markdown(f"**规则ID:** `{rh.get('rule_id')}`")
                            if rh.get("samples"):
                                st.markdown("**命中日志示例:**")
                                for i, sample in enumerate(rh["samples"][:5]):
                                    st.warning(f"#{i+1}: {sample}")
                            if rh.get("timestamps"):
                                times = [datetime.fromtimestamp(t/1000, tz=timezone.utc) for t in rh["timestamps"]]
                                st.markdown(f"**首次命中:** {times[0]}")
                                st.markdown(f"**最后命中:** {times[-1]}")
                                if len(times) > 1:
                                    intervals = [
                                        (times[i] - times[i-1]).total_seconds()
                                        for i in range(1, len(times))
                                    ]
                                    avg_int = np.mean(intervals)
                                    st.markdown(f"**平均命中间隔:** {avg_int:.1f} 秒")

        with tab2:
            st.subheader("📈 告警时间线")

            alerts = result.get("alerts", [])
            timeline = result.get("alert_timeline", [])

            if timeline:
                df_timeline = pd.DataFrame([
                    {
                        "时间": datetime.fromtimestamp(t["time"]/1000, tz=timezone.utc),
                        "规则ID": t["rule_id"],
                        "严重级别": t["severity"],
                        "值": 1
                    }
                    for t in timeline
                ])
                df_timeline = df_timeline.sort_values("时间")

                rule_ids = sorted(df_timeline["规则ID"].unique())
                rule_y_map = {rid: i for i, rid in enumerate(rule_ids)}
                df_timeline["Y轴"] = df_timeline["规则ID"].map(rule_y_map)

                color_map = {"critical": "#dc2626", "warning": "#ca8a04", "info": "#2563eb"}
                df_timeline["颜色"] = df_timeline["严重级别"].map(lambda x: color_map.get(x, "#6b7280"))

                st.markdown("**告警触发时间散点图**")
                import plotly.express as px

                fig = px.scatter(
                    df_timeline,
                    x="时间",
                    y="规则ID",
                    color="严重级别",
                    color_discrete_map=color_map,
                    title="告警触发时间线 (横轴时间, 纵轴规则, 颜色=严重级别)",
                    hover_data={"时间": True, "规则ID": True, "严重级别": True}
                )
                fig.update_layout(height=300 + len(rule_ids) * 40)
                st.plotly_chart(fig, use_container_width=True)

                st.divider()
                st.markdown("**按时间聚合告警频次**")
                agg_minutes = st.slider("聚合粒度(分钟)", 1, 60, 5, 1, key="agg_min")
                df_timeline["时间桶"] = df_timeline["时间"].dt.floor(f"{agg_minutes}min")
                freq = df_timeline.groupby(["时间桶", "规则ID"]).size().reset_index(name="次数")
                fig2 = px.bar(
                    freq,
                    x="时间桶",
                    y="次数",
                    color="规则ID",
                    title=f"每{agg_minutes}分钟告警数量"
                )
                st.plotly_chart(fig2, use_container_width=True)

            if alerts:
                with st.expander("📄 完整告警列表"):
                    alert_rows = []
                    for a in alerts[:100]:
                        alert_rows.append({
                            "告警ID": a["id"][:8],
                            "规则名称": a["ruleName"],
                            "严重级别": a["severity"],
                            "触发时间": datetime.fromtimestamp(a["triggeredAt"]/1000, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                            "匹配日志数": len(a.get("logs", [])),
                            "恢复告警": "是" if a.get("isRecovery") else "否",
                            "分组Key": a.get("groupKey", "")[:30],
                            "序列Key": a.get("sequenceKey", "")[:30]
                        })
                    st.dataframe(pd.DataFrame(alert_rows), use_container_width=True)

        with tab3:
            st.subheader("📋 规则详情")
            try:
                import yaml
                rules_data = yaml.safe_load(rules_content.decode("utf-8"))
                if isinstance(rules_data, dict) and "rules" in rules_data:
                    rules_data = rules_data["rules"]
                if isinstance(rules_data, list):
                    for rule in rules_data:
                        with st.expander(f"📜 {rule.get('name', rule.get('id', '未命名'))}"):
                            st.code(yaml.dump(rule, allow_unicode=True), language="yaml")
            except:
                pass

            st.divider()
            st.subheader("⚡ 参数调优建议")

            if rule_hits:
                for rh in rule_hits:
                    if rh.get("count", 0) > 0:
                        times = rh.get("timestamps", [])
                        if len(times) > 1:
                            intervals = [times[i] - times[i-1] for i in range(1, len(times))]
                            if all(i < test_slide * 1000 for i in intervals[:5]):
                                st.warning(f"⚠️ **{rh.get('rule_name')}** 命中过于频繁，建议:")
                                st.markdown(f"""
                                - 提高阈值: 当前 `{test_threshold}` → 建议 `{test_threshold * 2}`
                                - 增大窗口: 当前 `{test_window}s` → 建议 `{test_window * 2}s`
                                - 增加冷却期 (cooldown_seconds)
                                """)
                            elif len(times) == 1:
                                st.info(f"ℹ️ **{rh.get('rule_name')}** 仅命中1次，建议:")
                                st.markdown(f"""
                                - 降低阈值: 当前 `{test_threshold}` → 建议 `{max(1, test_threshold // 2)}`
                                - 缩小窗口: 当前 `{test_window}s` → 建议 `{max(10, test_window // 2)}s`
                                """)
                    else:
                        st.success(f"✅ **{rh.get('rule_name')}** 未命中，参数合适或需要降低灵敏度")

    else:
        st.error("测试执行失败")
