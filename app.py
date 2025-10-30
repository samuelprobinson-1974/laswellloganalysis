
# app.py — Full Dash LAS Well Log Analysis App

import io
import re
import base64
import lasio
import numpy as np
import pandas as pd
import numexpr as ne
from dash import Dash, html, dcc, Input, Output, State
import plotly.graph_objects as go

app = Dash(__name__)
server = app.server
app.title = "LAS Well Log Analysis (Dash)"

app.layout = html.Div([
    html.H1("LAS Well Log Analysis Tool — Dash"),
    dcc.Upload(
        id="upload-las",
        children=html.Div(["Drag & Drop or ", html.A("Select a LAS File")]),
        style={'width': '100%', 'height': '80px', 'lineHeight': '80px',
               'borderWidth': '2px', 'borderStyle': 'dashed', 'borderRadius': '5px',
               'textAlign': 'center', 'margin': '10px'},
        multiple=False
    ),
    html.Div(id="las-info"),
    html.Div(id="curve-controls"),
    html.H3("Curve Selection and Scaling"),
    dcc.Dropdown(id="curve-select", multi=True, placeholder="Select curves to plot"),
    html.Div(id="scaling-inputs"),
    html.H3("Shading Controls"),
    html.Div([
        dcc.Dropdown(id="shade-curve", placeholder="Curve to shade"),
        dcc.Input(id="shade-value", placeholder="Set value (e.g. 60)", type="number"),
        html.Button("Apply Shading", id="shade-btn")
    ]),
    dcc.Graph(id="welllog-plot"),
    html.H3("Calculated Curve"),
    html.Div([
        dcc.Input(id="calc-name", placeholder="Curve name (e.g., CALC1)", type="text"),
        dcc.Input(id="calc-expr", placeholder="Expression (e.g., (GR+NPHI)/2)", type="text"),
        html.Button("Add Curve", id="add-curve-btn")
    ]),
    html.Br(),
    html.Button("Export LAS", id="export-las-btn"),
    dcc.Download(id="download-las")
])

app.las = None
app.df = None
shading = {}

@app.callback(
    [Output("las-info", "children"), Output("curve-select", "options"), Output("shade-curve", "options")],
    Input("upload-las", "contents"),
    State("upload-las", "filename")
)
def load_las(content, filename):
    if not content:
        return "Upload a LAS file to begin.", [], []
    content_type, content_string = content.split(',')
    decoded = base64.b64decode(content_string)
    las = lasio.read(io.BytesIO(decoded))
    df = las.df()
    app.las = las
    app.df = df
    curve_options = [{'label': c, 'value': c} for c in df.columns]
    info = html.Div([
        html.H4(f"Loaded: {filename}"),
        html.P(f"Curves: {', '.join(df.columns)}"),
        html.P(f"Depth range: {df.index.min()} - {df.index.max()}")
    ])
    return info, curve_options, curve_options

@app.callback(
    Output("scaling-inputs", "children"),
    Input("curve-select", "value")
)
def make_scaling_inputs(selected_curves):
    if not selected_curves:
        return html.P("Select curves to configure scaling.")
    return html.Div([
        html.Div([
            html.Label(c),
            dcc.Input(id={"type": "scale-min", "index": c}, placeholder="Min", type="number"),
            dcc.Input(id={"type": "scale-max", "index": c}, placeholder="Max", type="number")
        ], style={'margin': '5px'}) for c in selected_curves
    ])

@app.callback(
    Output("welllog-plot", "figure"),
    [Input("curve-select", "value"),
     Input({"type": "scale-min", "index": ALL}, "value"),
     Input({"type": "scale-max", "index": ALL}, "value"),
     Input("shade-btn", "n_clicks"),
     State("shade-curve", "value"),
     State("shade-value", "value")]
)
def update_plot(selected, mins, maxs, shade_clicks, shade_curve, shade_value):
    if app.df is None or not selected:
        return go.Figure()
    df = app.df.copy()
    depth = df.index.values
    fig = go.Figure()
    for i, mn in enumerate(selected):
        x = df[mn]
        if mins and maxs and i < len(mins) and mins[i] is not None and maxs[i] is not None:
            x = np.clip(x, mins[i], maxs[i])
        fig.add_trace(go.Scatter(x=x, y=depth, mode="lines", name=mn))
    if shade_curve and shade_value is not None and shade_curve in df.columns:
        fig.add_trace(go.Scatter(
            x=np.minimum(df[shade_curve], shade_value),
            y=depth,
            fill='tonextx',
            mode='lines',
            name=f"Shade {shade_curve} < {shade_value}",
            fillcolor='rgba(0,200,200,0.3)'
        ))
    fig.update_yaxes(autorange="reversed", title="Depth")
    fig.update_layout(height=700, showlegend=True)
    return fig

@app.callback(
    Output("welllog-plot", "figure", allow_duplicate=True),
    Input("add-curve-btn", "n_clicks"),
    State("calc-name", "value"),
    State("calc-expr", "value"),
    prevent_initial_call="initial_duplicate"
)
def add_calc_curve(n_clicks, name, expr):
    if not n_clicks or not name or not expr or app.df is None:
        raise dash.exceptions.PreventUpdate
    df = app.df.copy()
    local_dict = {c: df[c].values for c in df.columns}
    try:
        df[name] = ne.evaluate(expr, local_dict=local_dict)
        app.df[name] = df[name]
    except Exception as e:
        print("Error evaluating expression:", e)
        raise dash.exceptions.PreventUpdate
    depth = df.index.values
    fig = go.Figure()
    for c in df.columns[:3]:
        fig.add_trace(go.Scatter(x=df[c], y=depth, mode="lines", name=c))
    fig.add_trace(go.Scatter(x=df[name], y=depth, mode="lines", name=name, line=dict(dash='dot')))
    fig.update_yaxes(autorange="reversed", title="Depth")
    fig.update_layout(height=700, showlegend=True)
    return fig

@app.callback(
    Output("download-las", "data"),
    Input("export-las-btn", "n_clicks"),
    prevent_initial_call=True
)
def export_las(n_clicks):
    if app.las is None or app.df is None:
        return dash.no_update
    las = app.las
    las.set_data_from_df(app.df)
    buf = io.StringIO()
    las.write(buf, version=2.0)
    return dict(content=buf.getvalue(), filename="modified.las")

if __name__ == "__main__":
    app.run_server(debug=True)
